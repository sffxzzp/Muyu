import { STORAGE_KEY, StorageError, type Exclusive, type StorageLike } from './storage'
import type { Runtime } from './runner'

export const RUNS_KEY = 'muyu.runner.v2'
export const JOB_LOCK_PREFIX = 'muyu-translation-job:'
export const EXECUTION_LOCK = 'muyu-translation-execution'
export const jobLockName = (id: string) => JOB_LOCK_PREFIX + id

export interface RunEntry extends Runtime {
  owner: string
  group: string
  rpm: number
}
interface RateState {
  lastAt: number
  nextAt: number
}
interface State {
  version: 3
  cooldownUntil: number
  runs: Record<string, RunEntry>
  rates: Record<string, RateState>
}
interface Hooks {
  storage: StorageLike
  exclusive: Exclusive
  heldJobs(): Promise<Set<string>>
  now?(): number
}

// API keys stay in memory unless explicitly remembered by the user. Only a
// digest of the endpoint + credential identifies the shared rate-limit pool.
export async function rateGroup(baseUrl: string, apiKey: string): Promise<string> {
  const url = new URL(baseUrl.trim())
  const normalized = url.href.replace(/\/+$/, '')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized + '\n' + apiKey))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class Coordinator {
  private readonly now: () => number
  constructor(private hooks: Hooks) {
    this.now = hooks.now ?? Date.now
  }

  private async change<T>(action: (state: State) => T): Promise<T> {
    return this.hooks.exclusive(async () => {
      let raw: string | null
      let state: State
      try {
        raw = this.hooks.storage.getItem(RUNS_KEY)
        state = raw ? JSON.parse(raw) : { version: 3, cooldownUntil: 0, runs: {}, rates: {} }
        if (
          !state ||
          !state.runs ||
          !state.rates ||
          typeof state.runs !== 'object' ||
          typeof state.rates !== 'object' ||
          Array.isArray(state.runs) ||
          Array.isArray(state.rates)
        )
          throw new Error('invalid scheduler state')
      } catch {
        throw new StorageError('任务调度记录无法读取，请先导出任务备份，再清空本地数据')
      }
      if (!raw || state.version !== 3) {
        // Preserve the old global cooldown once, before workspace v1 is migrated.
        const legacy = JSON.parse(this.hooks.storage.getItem(STORAGE_KEY) ?? '{}')
        state.version = 3
        state.cooldownUntil = Number.isFinite(legacy.nextRequestAt) ? legacy.nextRequestAt : 0
        for (const run of Object.values(state.runs)) {
          delete (run as RunEntry & { state?: string }).state
          delete (run as RunEntry & { order?: number }).order
        }
        for (const [group, rate] of Object.entries(state.rates))
          state.rates[group] = { lastAt: rate.lastAt, nextAt: rate.nextAt }
      }
      // Locks survive background timer throttling and are released by the
      // browser on tab closure. Heartbeat timestamps are not ownership proof.
      const held = await this.hooks.heldJobs()
      for (const id of Object.keys(state.runs)) {
        if (!held.has(id)) delete state.runs[id]
      }
      for (const [group, rate] of Object.entries(state.rates)) {
        if (
          rate.nextAt < this.now() - 86_400_000 &&
          !Object.values(state.runs).some((run) => run.group === group)
        )
          delete state.rates[group]
      }
      const result = action(state)
      const serialized = JSON.stringify({
        version: state.version,
        cooldownUntil: state.cooldownUntil,
        runs: state.runs,
        rates: state.rates,
      })
      if (serialized !== raw) {
        try {
          this.hooks.storage.setItem(RUNS_KEY, serialized)
        } catch {
          throw new StorageError('浏览器无法保存任务调度状态，已停止发送新请求，请先备份并清理本地数据')
        }
      }
      return result
    })
  }

  snapshot(): Promise<Record<string, RunEntry>> {
    return this.change((state) => state.runs)
  }

  register(id: string, owner: string, group: string, rpm: number, runtime: Runtime): Promise<void> {
    return this.change((state) => {
      state.runs[id] = { ...runtime, owner, group, rpm }
    })
  }

  // Called only while holding EXECUTION_LOCK. The browser provides FIFO admission
  // and cancellation; this registry publishes progress and cross-tab pause requests.
  activate(id: string, owner: string): Promise<void> {
    return this.change((state) => {
      const run = state.runs[id]
      if (!run || run.owner !== owner || run.pauseRequested) throw new Error('任务运行状态已改变，请重新开始')
      // Older open pages do not use the execution lock. Never overlap their
      // in-flight work during an upgrade; saved workspace v2 stops their next request.
      if (Object.values(state.runs).some((other) => other !== run && other.phase !== 'queued'))
        throw new Error('另一个标签页仍在使用旧版，请等当前请求结束并刷新该页面')
      run.phase = 'idle'
    })
  }

  publish(id: string, owner: string, runtime: Runtime): Promise<boolean> {
    return this.change((state) => {
      const run = state.runs[id]
      if (!run || run.owner !== owner) throw new Error('任务已停止，请刷新后从保存的进度继续')
      const pauseRequested = run.pauseRequested || runtime.pauseRequested
      Object.assign(run, runtime, { pauseRequested })
      if (pauseRequested && run.phase === 'requesting') run.phase = 'pausing'
      return pauseRequested
    })
  }

  pause(id: string): Promise<void> {
    return this.change((state) => {
      const run = state.runs[id]
      if (run) {
        run.pauseRequested = true
        if (run.phase === 'requesting') run.phase = 'pausing'
      }
    })
  }

  release(id: string, owner?: string): Promise<void> {
    return this.change((state) => {
      if (!owner || state.runs[id]?.owner === owner) delete state.runs[id]
    })
  }

  // Zero means reserved; any other value is a wake-up time, never a grant.
  reserve(id: string, owner: string): Promise<number> {
    return this.change((state) => {
      const run = state.runs[id]
      if (!run || run.owner !== owner || run.phase === 'queued')
        throw new Error('任务运行状态已改变，请重新开始')
      const now = this.now()
      if (run.pauseRequested) return now + 100
      const interval = Math.ceil(60000 / run.rpm)
      const rate = (state.rates[run.group] ??= { lastAt: 0, nextAt: 0 })
      const due = Math.max(rate.nextAt, rate.lastAt ? rate.lastAt + interval : 0, state.cooldownUntil)
      if (due > now) return due
      rate.lastAt = now
      rate.nextAt = now + interval
      return 0
    })
  }

  cooldown(id: string, owner: string, until: number): Promise<void> {
    return this.change((state) => {
      const run = state.runs[id]
      if (!run || run.owner !== owner) return
      const rate = (state.rates[run.group] ??= { lastAt: 0, nextAt: 0 })
      rate.nextAt = Math.max(rate.nextAt, until)
    })
  }
}
