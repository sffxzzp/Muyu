import { errorMessage, message, type Message } from './messages'
import { computed, reactive, ref, shallowReactive, watch } from 'vue'
import { useTranslationEdits } from './translationEdits'
import { useMemoryEdits } from './memoryEdits'
import { boundedText, limits } from './validation'
import { download } from './files'
import {
  Coordinator,
  EXECUTION_LOCK,
  JOB_LOCK_PREFIX,
  RUNS_KEY,
  jobLockName,
  rateGroup,
  type RunEntry,
} from './coordinator'
import { clearUIPreferences } from './preferences'
import {
  applyTranslationEdit,
  applyMemoryEdit,
  memoryValue,
  emptyWorkspace,
  loadWorkspace,
  makeBackup,
  mergeJobCheckpoint,
  mutateWorkspace,
  parseBackup,
  redactRecoveryRecord,
  saveWorkspace,
  STORAGE_KEY,
  StorageError,
  validateJob,
  WRITE_LOCK,
  type Exclusive,
  type MemoryField,
} from './storage'
import { Runner, type Runtime } from './runner'
import { translate } from './translation'
import {
  buildChunks,
  event,
  localID,
  type APIProfile,
  type Job,
  type Settings,
  type SubtitleDocument,
  type Term,
  type Workspace,
} from './types'

const owner = localID()
let blocked = false
let initial = emptyWorkspace()
let initialNotice: Message = ''
try {
  initial = loadWorkspace(localStorage)
  if (initial.recovery.length)
    initialNotice = message('有 {0} 条记录需要恢复，可在任务记录中下载原始数据', {
      0: initial.recovery.length,
    })
} catch (error) {
  blocked = true
  initialNotice = errorMessage(error)
}

export const workspace = reactive(initial)
export const notice = ref(initialNotice)
export const unsaved = ref(false)
export const usedBytes = ref(0)
export const runs = reactive<Record<string, RunEntry>>({})
const workers = shallowReactive(
  new Map<string, { runtime: Runtime; runner?: Runner; queueAbort: AbortController }>(),
)
export const busy = computed(() => workers.size > 0 || Object.keys(runs).length > 0)
export const remoteBusy = computed(() => Object.values(runs).some((run) => run.owner !== owner))
export const runningCount = computed(() => Object.values(runs).filter((run) => run.phase !== 'queued').length)
export const queuedCount = computed(() => Object.values(runs).filter((run) => run.phase === 'queued').length)
export function runtimeFor(id: string): Runtime | undefined {
  return workers.get(id)?.runtime ?? runs[id]
}
export function jobBusy(id: string): boolean {
  return !!runtimeFor(id)
}

const keys = reactive(new Map<string, string>())
const jobKeys = reactive(new Map<string, string>())
const dirty = new Map<string, number>()
const keyName = (url: string) => new URL(url.trim()).href.replace(/\/+$/, '')
if (initial.preferences.apiKey) keys.set(keyName(initial.preferences.baseUrl), initial.preferences.apiKey)
export function apiKeyFor(profile: APIProfile, jobId?: string): string {
  return (jobId ? jobKeys.get(jobId) : undefined) ?? keys.get(keyName(profile.baseUrl)) ?? ''
}

// Translation requires Web Locks. On an insecure origin users can still
// import/export/edit locally, but cannot start an unsafe cross-tab runner.
const exclusive: Exclusive = async (action) =>
  navigator.locks ? navigator.locks.request(WRITE_LOCK, action) : action()
async function heldJobs(): Promise<Set<string>> {
  const locks = await navigator.locks?.query()
  return new Set(
    (locks?.held ?? []).flatMap((lock) =>
      lock.name?.startsWith(JOB_LOCK_PREFIX) ? [lock.name.slice(JOB_LOCK_PREFIX.length)] : [],
    ),
  )
}
const coordinator = new Coordinator({
  storage: localStorage,
  exclusive,
  heldJobs,
})
// Scheduler migration must preserve a legacy cooldown before any workspace write.
let schedulerReady = coordinator.snapshot().then(() => {})
void schedulerReady.catch((error) => {
  notice.value = errorMessage(error)
})

function applyLatest(latest: Workspace): void {
  if (latest.revision < workspace.revision) return
  const current = new Map(workspace.jobs.map((job) => [job.id, job]))
  const jobs = latest.jobs.map((job) => {
    if ((workers.has(job.id) || dirty.has(job.id)) && current.has(job.id)) {
      const active = current.get(job.id)!
      if (!dirty.has(job.id)) {
        Object.assign(active.translations, job.translations)
        active.revision = job.revision
        active.updatedAt = Math.max(active.updatedAt, job.updatedAt)
      }
      return active
    }
    return job
  })
  // Failed checkpoints remain exportable even if another tab deletes the
  // saved copy. Never replace unsaved results with older disk data.
  for (const [id, job] of current) if (dirty.has(id) && !jobs.some((saved) => saved.id === id)) jobs.push(job)
  Object.assign(workspace, latest, { jobs })
  const p = workspace.preferences
  if (p.rememberKey && p.apiKey) keys.set(keyName(p.baseUrl), p.apiKey)
}

function refresh(): void {
  if (blocked) return
  try {
    applyLatest(loadWorkspace(localStorage))
    usedBytes.value = new Blob([localStorage.getItem(STORAGE_KEY) ?? '']).size
  } catch (error) {
    notice.value = errorMessage(error)
  }
}

async function commit(change: (latest: Workspace) => void): Promise<void> {
  if (blocked) throw new StorageError(initialNotice)
  try {
    await schedulerReady
    const result = await mutateWorkspace(localStorage, exclusive, change)
    applyLatest(result.workspace)
    usedBytes.value = result.bytes
  } catch (error) {
    notice.value = errorMessage(error)
    throw error
  }
}

async function persistJob(job: Job): Promise<void> {
  job.updatedAt = Date.now()
  const checkpoint = validateJob(job)
  // Editors address terms by ID. Keep the assigned IDs in the live task,
  // including while its worker is active or a storage write fails.
  job.glossary = checkpoint.glossary
  const base = dirty.get(job.id) ?? job.revision
  let revision = job.revision
  try {
    await commit((latest) => {
      const index = latest.jobs.findIndex((saved) => saved.id === job.id)
      if (index < 0) throw new Error('任务已被删除，请先导出本页未保存的进度')
      if (dirty.has(job.id) && latest.jobs[index].revision !== base)
        throw new Error('任务已在其他标签页更新，请先导出本页未保存的进度')
      latest.jobs[index] = mergeJobCheckpoint(latest.jobs[index], checkpoint)
      revision = latest.jobs[index].revision
    })
    job.revision = revision
    dirty.delete(job.id)
  } catch (error) {
    dirty.set(job.id, base)
    throw error
  } finally {
    unsaved.value = dirty.size > 0
  }
}

async function withJobLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    if (jobBusy(id)) throw new Error('请先暂停这个任务，再修改它')
    return action()
  }
  return navigator.locks.request(jobLockName(id), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('这个任务正在运行或排队，请先暂停它；其他任务不受影响')
    return action()
  })
}

export async function saveProfile(
  profile: APIProfile,
  apiKey: string,
  rememberKey: boolean,
  job?: Job,
): Promise<void> {
  let url: URL
  try {
    url = new URL(profile.baseUrl)
  } catch {
    throw new Error('请填写有效的 Base URL 和模型名称')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !profile.model.trim() ||
    !boundedText(profile.model, limits.model) ||
    !boundedText(profile.baseUrl, limits.baseUrl) ||
    !boundedText(apiKey, limits.apiKey) ||
    /[^\x20-\x7e]/.test(apiKey.trim())
  )
    throw new Error('请填写有效的 Base URL 和模型名称')
  profile = { ...profile, baseUrl: keyName(profile.baseUrl), model: profile.model.trim() }
  const save = async () => {
    if (job && dirty.has(job.id)) await persistJob(job)
    await commit((latest) => {
      latest.preferences = { ...profile, rememberKey, apiKey: rememberKey ? apiKey.trim() : '' }
      if (job) {
        const saved = latest.jobs.find((item) => item.id === job.id)
        if (!saved) throw new Error('任务已被删除')
        saved.profile = { ...profile }
        saved.updatedAt = Date.now()
        saved.revision++
      }
    })
    if (apiKey.trim()) keys.set(keyName(profile.baseUrl), apiKey.trim())
    else keys.delete(keyName(profile.baseUrl))
    if (job) jobKeys.set(job.id, apiKey.trim())
  }
  if (job) await withJobLock(job.id, save)
  else await save()
}

export async function createJob(
  name: string,
  document: SubtitleDocument,
  settings: Settings,
  glossary: Term[],
): Promise<Job> {
  const id = localID()
  await commit((latest) => {
    if (latest.jobs.length + latest.recovery.length >= 100)
      throw new Error('任务已达 100 个，请导出备份并清理旧任务')
    const now = Date.now()
    const job: Job = {
      id,
      revision: latest.revision + 1,
      name,
      createdAt: now,
      updatedAt: now,
      document: JSON.parse(JSON.stringify(document)),
      settings: { ...settings },
      profile: {
        baseUrl: latest.preferences.baseUrl,
        model: latest.preferences.model,
        tokenParameter: latest.preferences.tokenParameter,
      },
      chunks: buildChunks(document.cues, settings),
      completedChunks: 0,
      translations: {},
      glossary: JSON.parse(JSON.stringify(glossary)),
      lastGlossarySent: null,
      glossaryHistory: [],
      styleNotes: '',
      status: 'ready',
      error: '',
      events: [],
      requests: 0,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    event(
      job,
      message('已导入 {0} 条字幕，分为 {1} 个语义块', { 0: document.cues.length, 1: job.chunks.length }),
    )
    latest.jobs.unshift(validateJob(job))
  })
  return workspace.jobs.find((job) => job.id === id)!
}

export async function updateJob(id: string, update: (job: Job) => void): Promise<void> {
  await withJobLock(id, async () => {
    const local = workspace.jobs.find((job) => job.id === id)
    if (local && dirty.has(id)) await persistJob(local)
    await commit((latest) => {
      const index = latest.jobs.findIndex((job) => job.id === id)
      if (index < 0) throw new Error('任务已被删除')
      const job = latest.jobs[index]
      update(job)
      job.updatedAt = Date.now()
      job.revision++
      latest.jobs[index] = validateJob(job)
    })
  })
}

export async function saveTranslation(
  id: string,
  cueId: number,
  text: string,
  previous: string,
): Promise<void> {
  // Completed rows can be edited without taking the long-lived runner lock.
  // Only this row changes; progress, glossary, credentials and queue stay intact.
  const local = workspace.jobs.find((job) => job.id === id)
  if (local && dirty.has(id)) await persistJob(local)
  try {
    await commit((latest) => {
      const job = latest.jobs.find((item) => item.id === id)
      if (!job) throw new Error('任务已被删除')
      applyTranslationEdit(job, cueId, text, previous)
    })
  } catch (error) {
    refresh()
    throw error
  }
}

export async function deleteJob(id: string): Promise<void> {
  await withJobLock(id, async () => {
    await commit((latest) => {
      latest.jobs = latest.jobs.filter((job) => job.id !== id)
    })
    dirty.delete(id)
    jobKeys.delete(id)
    unsaved.value = dirty.size > 0
    workspace.jobs = workspace.jobs.filter((job) => job.id !== id)
  })
}

export async function clearWorkspace(): Promise<void> {
  await exclusive(async () => {
    if ((await heldJobs()).size || busy.value) throw new Error('请先暂停所有正在运行或排队的任务')
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem('muyu.runner.v1')
    localStorage.removeItem(RUNS_KEY)
    clearUIPreferences()
    keys.clear()
    jobKeys.clear()
    dirty.clear()
    schedulerReady = Promise.resolve()
    blocked = false
    initialNotice = ''
    Object.assign(workspace, emptyWorkspace())
    notice.value = ''
    unsaved.value = false
    usedBytes.value = saveWorkspace(localStorage, workspace)
  })
}

export function exportBackup(jobs?: Job[]): void {
  if (blocked) {
    download(
      redactRecoveryRecord(localStorage.getItem(STORAGE_KEY) ?? ''),
      'muyu-original-records.json',
      'application/json',
    )
    return
  }
  const snapshot = memoryEdits.snapshot(translationEdits.snapshot(jobs ?? workspace.jobs))
  download(
    makeBackup(snapshot.jobs, [...(jobs ? [] : workspace.recovery), ...snapshot.recovery]),
    `muyu-backup-${new Date().toISOString().slice(0, 10)}.json`,
    'application/json',
  )
}

export function exportRecovery(id: string): void {
  const item = workspace.recovery.find((record) => record.id === id)
  if (item)
    download(
      redactRecoveryRecord(JSON.stringify({ kind: 'muyu-backup', version: 3, jobs: [item.data] }, null, 2)),
      'muyu-recovery.json',
      'application/json',
    )
}

export async function deleteRecovery(id: string): Promise<void> {
  await commit((latest) => {
    latest.recovery = latest.recovery.filter((record) => record.id !== id)
  })
}

export async function importBackup(file: File): Promise<number> {
  if (file.size > 15 * 1024 * 1024) throw new Error('备份文件不能超过 15 MB')
  const incoming = parseBackup(await file.text())
  await commit((latest) => {
    const existing = new Set(latest.jobs.map((job) => job.id))
    for (const job of incoming.jobs) {
      job.revision = latest.revision + 1
      if (existing.has(job.id)) {
        job.id = localID()
        job.name = job.name.slice(0, 470) + '（导入副本）'
      }
      existing.add(job.id)
      event(job, '已从备份恢复。API Key 不包含在备份中，继续前请检查接口配置')
    }
    if (latest.jobs.length + latest.recovery.length + incoming.jobs.length + incoming.recovery.length > 100)
      throw new Error('导入后任务数量超过 100 个，请先清理旧任务')
    latest.jobs = [...incoming.jobs, ...latest.jobs]
    latest.recovery.push(...incoming.recovery.map((item) => ({ ...item, id: localID() })))
  })
  if (incoming.recovery.length)
    notice.value = message('有 {0} 条记录需要恢复，可在任务记录中下载原始数据', {
      0: incoming.recovery.length,
    })
  return incoming.jobs.length
}

let syncing: Promise<void> | undefined
async function reconcile(): Promise<void> {
  if (blocked) return
  if (syncing) return syncing
  syncing = (async () => {
    try {
      const latest = await coordinator.snapshot()
      for (const id of Object.keys(runs)) if (!latest[id]) delete runs[id]
      Object.assign(runs, latest)
      for (const [id, worker] of workers)
        if (latest[id]?.pauseRequested) {
          worker.runtime.pauseRequested = true
          worker.runner?.pause()
          worker.queueAbort.abort()
        }
    } catch (error) {
      notice.value = errorMessage(error)
      for (const worker of workers.values()) {
        worker.runtime.pauseRequested = true
        worker.runner?.pause()
        worker.queueAbort.abort()
      }
      // Storage may be full even when removing a stale registry entry. The
      // released browser lock still lets the UI offer cleanup and recovery.
      try {
        const held = await heldJobs()
        for (const id of Object.keys(runs)) if (!held.has(id)) delete runs[id]
      } catch {
        /* retain ownership conservatively if lock queries fail */
      }
    }
  })().finally(() => {
    syncing = undefined
  })
  return syncing
}

export async function pauseJob(id: string): Promise<void> {
  const worker = workers.get(id)
  if (worker) worker.runtime.pauseRequested = true
  worker?.runner?.pause()
  worker?.queueAbort.abort()
  await coordinator.pause(id)
  await reconcile()
}

export async function startJob(id: string): Promise<void> {
  if (!navigator.locks)
    throw new Error('当前浏览器无法安全锁定翻译任务，请使用新版浏览器，并通过 HTTPS 或 localhost 访问')
  await memoryEdits.flush(id)
  // Claim the local worker synchronously after the async draft flush. Two
  // clicks must not overwrite each other's worker while waiting for a lock.
  if (workers.has(id)) throw new Error('这个任务已经开始或正在排队')
  const runtime = reactive<Runtime>({
    activeJobId: id,
    phase: 'queued',
    waitUntil: 0,
    attempt: 0,
    pauseRequested: false,
  })
  const worker = { runtime, queueAbort: new AbortController(), runner: undefined as Runner | undefined }
  workers.set(id, worker)
  try {
    await withJobLock(id, async () => {
      const job = workspace.jobs.find((item) => item.id === id)
      if (job && dirty.has(id)) await persistJob(job)
      refresh()
      const saved = loadWorkspace(localStorage).jobs.find((item) => item.id === id)
      if (!saved || !job) throw new Error('任务已被删除')
      Object.assign(job, saved)
      if (job.completedChunks === job.chunks.length) return
      const key = apiKeyFor(job.profile, id)
      if (!key) throw new Error('请先为此任务的接口填写 API Key')
      jobKeys.set(id, key)
      const group = await rateGroup(job.profile.baseUrl, key)
      const { queueAbort } = worker
      const runner = new Runner(runtime, {
        workspace: () => workspace,
        save: persistJob,
        request: translate,
        reserve: () => coordinator.reserve(id, owner),
        cooldown: (until) => coordinator.cooldown(id, owner, until),
        changed: async () => {
          if (await coordinator.publish(id, owner, runtime)) runner.pause()
          await reconcile()
        },
        notify: (message) => {
          notice.value = message
        },
      })
      worker.runner = runner
      try {
        await coordinator.register(id, owner, group, job.settings.rpm, runtime)
        job.status = 'paused'
        job.error = ''
        event(job, '任务已加入队列，空出名额后自动开始')
        await persistJob(job)
        await reconcile()
        let started = false
        try {
          await navigator.locks.request(EXECUTION_LOCK, { signal: queueAbort.signal }, async () => {
            if (runtime.pauseRequested) return
            await coordinator.activate(id, owner)
            runtime.phase = 'idle'
            try {
              await reconcile()
              if (runtime.pauseRequested) return
              started = true
              await runner.run(id, key)
            } finally {
              // Publish release before another tab receives the execution lock.
              await coordinator.release(id, owner)
            }
          })
        } catch (error) {
          if (!queueAbort.signal.aborted) throw error
        }
        if (!started) {
          job.status = 'paused'
          event(job, '已退出等待队列，继续时会重新排队')
          await persistJob(job)
        }
      } catch (error) {
        job.status = 'paused'
        job.error = errorMessage(error)
        try {
          await persistJob(job)
        } catch {
          /* in-memory checkpoint remains exportable */
        }
        throw error
      } finally {
        try {
          await coordinator.release(id, owner)
        } catch (error) {
          notice.value = errorMessage(error)
        }
      }
    })
  } finally {
    workers.delete(id)
    refresh()
    await reconcile()
  }
}

export const translationEdits = useTranslationEdits({
  read: (jobId, cueId) => workspace.jobs.find((job) => job.id === jobId)?.translations[cueId],
  save: saveTranslation,
})
export const memoryEdits = useMemoryEdits({
  read: (jobId, field) =>
    memoryValue(
      workspace.jobs.find((job) => job.id === jobId),
      field,
    ),
  save: (jobId, field: MemoryField, value, previous) =>
    updateJob(jobId, (job) => applyMemoryEdit(job, field, value, previous)),
})
export const unsavedEditCount = computed(
  () => translationEdits.unsavedCount.value + memoryEdits.unsavedCount.value,
)
watch(
  () => workspace.jobs.map((job) => job.id),
  (ids) => {
    translationEdits.retain(new Set(ids))
    memoryEdits.retain(new Set(ids))
  },
)

refresh()
void reconcile()
window.addEventListener('storage', (e) => {
  if (e.key === null || (e.key === STORAGE_KEY && e.newValue === null)) {
    keys.clear()
    jobKeys.clear()
    for (const worker of workers.values()) {
      worker.runner?.stop()
      worker.queueAbort.abort()
    }
    workspace.revision = 0
  }
  if (e.key === STORAGE_KEY || e.key === null) refresh()
  if (e.key === STORAGE_KEY || e.key === RUNS_KEY || e.key === null) void reconcile()
})
setInterval(() => {
  if (busy.value) void reconcile()
}, 1000)
window.addEventListener('pageshow', () => {
  refresh()
  void reconcile()
})
window.addEventListener('beforeunload', (e) => {
  if (unsaved.value || unsavedEditCount.value) {
    e.preventDefault()
    e.returnValue = ''
  }
})
window.addEventListener('pagehide', () => {
  for (const worker of workers.values()) {
    worker.runner?.stop()
    worker.queueAbort.abort()
  }
})
