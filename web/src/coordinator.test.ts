import { describe, expect, it } from 'vitest'
import { Coordinator, rateGroup, RUNS_KEY } from './coordinator'
import type { Runtime } from './runner'
import { STORAGE_KEY, type Exclusive } from './storage'
import { MemoryStorage } from './test-fixtures'

function mutex(): Exclusive {
  let tail = Promise.resolve()
  return <T>(action: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(action)
    tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}
function fixture() {
  const storage = new MemoryStorage(),
    held = new Set<string>()
  let now = 1_000_000
  const hooks = { storage, exclusive: mutex(), heldJobs: async () => held, now: () => now }
  const first = new Coordinator(hooks),
    second = new Coordinator(hooks)
  async function add(id: string, group = 'shared', rpm = 20, owner = 'one') {
    held.add(id)
    const runtime: Runtime = {
      activeJobId: id,
      phase: 'queued',
      waitUntil: 0,
      attempt: 0,
      pauseRequested: false,
    }
    await first.register(id, owner, group, rpm, runtime)
  }
  return {
    storage,
    held,
    hooks,
    first,
    second,
    add,
    time: (value: number) => {
      now = value
    },
  }
}

describe('cross-tab execution registry and shared RPM', () => {
  // Native Web Locks FIFO admission and queue cancellation are exercised in
  // multitask.spec.ts with two real pages, rather than reimplementing locks here.
  it('publishes queued and active tasks and refuses overlap with an older page', async () => {
    const h = fixture()
    await h.add('a')
    await h.add('b', 'shared', 20, 'two')
    await h.first.activate('a', 'one')
    await expect(h.second.activate('b', 'two')).rejects.toThrow('旧版')
    const runs = await h.second.snapshot()
    expect(runs.a.phase).toBe('idle')
    expect(runs.b.phase).toBe('queued')
    await h.first.release('a', 'one')
    await h.second.activate('b', 'two')
    expect((await h.first.snapshot()).b.phase).toBe('idle')
  })

  it('recovers closed pages without stealing a suspended background page or its key', async () => {
    const h = fixture()
    await h.add('a')
    await h.add('b', 'shared', 20, 'two')
    await h.first.activate('a', 'one')
    h.held.delete('a')
    expect((await h.second.snapshot()).a).toBeUndefined()
    h.time(100_000_000)
    expect((await h.first.snapshot()).b).toBeDefined()
    await expect(h.first.activate('b', 'one')).rejects.toThrow('状态已改变')
    await h.first.pause('b')
    await expect(h.second.activate('b', 'two')).rejects.toThrow('状态已改变')
  })

  it('preserves shared RPM when queued tasks hand off and change request intervals', async () => {
    const h = fixture()
    await h.add('a', 'same-key', 600)
    await h.add('b', 'same-key', 20, 'two')
    await h.first.activate('a', 'one')
    expect(await h.first.reserve('a', 'one')).toBe(0)
    await h.first.release('a', 'one')
    await h.second.activate('b', 'two')
    expect(await h.second.reserve('b', 'two')).toBe(1_003_000)
    h.time(1_003_000)
    expect(await h.second.reserve('b', 'two')).toBe(0)
  })

  it('persists cooldowns across reloads and keeps independent credentials independent', async () => {
    const h = fixture()
    await h.add('a', 'key-one')
    await h.add('b', 'key-two', 20, 'two')
    await h.first.activate('a', 'one')
    await h.first.reserve('a', 'one')
    await h.first.cooldown('a', 'one', 1_010_000)
    h.held.delete('a')
    await h.second.activate('b', 'two')
    expect(await h.second.reserve('b', 'two')).toBe(0)
    await h.second.release('b', 'two')
    const reloaded = new Coordinator(h.hooks)
    await h.add('replacement', 'key-one')
    await reloaded.activate('replacement', 'one')
    expect(await reloaded.reserve('replacement', 'one')).toBe(1_010_000)
  })

  it.each([false, true])(
    'migrates a legacy global cooldown once (existing scheduler: %s)',
    async (existing) => {
      const h = fixture()
      h.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, nextRequestAt: 1_020_000 }))
      if (existing)
        h.storage.setItem(
          RUNS_KEY,
          JSON.stringify({
            sequence: 2,
            runs: {},
            rates: { shared: { lastAt: 999000, nextAt: 1_002_000, waiting: ['old'] } },
          }),
        )
      await h.first.snapshot()
      h.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2 }))
      await h.add('a')
      await h.first.activate('a', 'one')
      expect(await h.first.reserve('a', 'one')).toBe(1_020_000)
      expect(h.storage.getItem(RUNS_KEY)).not.toContain('waiting')
      h.time(1_020_000)
      expect(await h.first.reserve('a', 'one')).toBe(0)
    },
  )

  it('cannot send a request when the reservation cannot be persisted', async () => {
    const h = fixture()
    await h.add('a')
    await h.first.activate('a', 'one')
    h.storage.full = true
    await expect(h.first.reserve('a', 'one')).rejects.toThrow('无法保存任务调度状态')
    expect(JSON.parse(h.storage.getItem(RUNS_KEY)!).rates).toEqual({})
  })

  it('normalizes endpoint identities and never persists credential text', async () => {
    const group = await rateGroup('https://EXAMPLE.com:443/v1/', 'secret-one')
    expect(group).toBe(await rateGroup('https://example.com/v1', 'secret-one'))
    expect(group).not.toBe(await rateGroup('https://example.com/v1', 'secret-two'))
    const h = fixture()
    await h.add('a', group)
    expect(h.storage.getItem(RUNS_KEY)).not.toContain('secret-one')
  })
})
