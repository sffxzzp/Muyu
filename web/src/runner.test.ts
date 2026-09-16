import { formatMessage, type Message } from './messages'
import { describe, expect, it } from 'vitest'
import { APIError, DirectConnectionError } from './transport'
import { Runner, sleep, type Runtime } from './runner'
import { loadWorkspace, saveWorkspace, StorageError } from './storage'
import { MemoryStorage, workspaceFixture } from './test-fixtures'
import { updateJobSettings, type Job, type TranslationResult, type TranslationTransport } from './types'

function response(body: any): TranslationResult {
  return {
    translations: body.cues.map((cue: any) => ({ id: cue.id, text: `译文 ${cue.id}` })),
    glossary: [...body.glossary, { source: `term-${body.cues[0].id}`, target: `术语 ${body.cues[0].id}` }],
    glossarySent: body.glossary.length,
    glossaryUsed: JSON.parse(JSON.stringify(body.glossary)),
    styleNotes: `风格 ${body.cues[0].id}`,
    warnings: [],
    usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
  }
}
function harness(count = 6) {
  const workspace = workspaceFixture(count),
    storage = new MemoryStorage(),
    calls: { body: any; at: number; transport: TranslationTransport }[] = [],
    notices: Message[] = []
  const rate = { nextAt: 0 }
  let now = 1_000_000
  const runtime: Runtime = { activeJobId: '', phase: 'idle', waitUntil: 0, attempt: 0, pauseRequested: false }
  const hooks = {
    workspace: () => workspace,
    save: () => {
      saveWorkspace(storage, workspace)
    },
    reserve: async (job: Job) => {
      if (rate.nextAt > now) return rate.nextAt
      rate.nextAt = now + Math.ceil(60000 / job.settings.rpm)
      saveWorkspace(storage, workspace)
      return 0
    },
    cooldown: async (until: number) => {
      rate.nextAt = Math.max(rate.nextAt, until)
      saveWorkspace(storage, workspace)
    },
    notify: (message: Message) => {
      notices.push(message)
    },
    now: () => now,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) return sleep(ms, signal)
      now += ms
    },
    request: async (
      body: any,
      _signal: AbortSignal,
      transport: TranslationTransport = 'direct',
    ): Promise<TranslationResult> => {
      calls.push({ body: JSON.parse(JSON.stringify(body)), at: now, transport })
      return response(body)
    },
  }
  const runner = new Runner(runtime, hooks)
  return { workspace, storage, calls, notices, hooks, runner, runtime, rate }
}

describe('sequential browser translation runner', () => {
  it('stops on truncation and resumes with smaller remaining chunks while retaining saved edits and memory', async () => {
    const h = harness(6)
    const request = h.hooks.request
    h.hooks.request = async (body, signal, transport) => {
      const result = await request(body, signal, transport)
      if (body.cues[0].id >= 3 && body.cues.length > 1)
        throw new APIError('模型输出被 Token 上限截断，请增大输出上限或减小分块', false)
      return result
    }
    await h.runner.run('test-job-1', 'dummy-key')
    const job = h.workspace.jobs[0]
    expect(h.calls).toHaveLength(2)
    expect(job.completedChunks).toBe(1)
    expect(job.status).toBe('error')
    job.translations[1] = '人工修正'
    const memory = { glossary: structuredClone(job.glossary), styleNotes: job.styleNotes }
    updateJobSettings(job, { ...job.settings, targetChunkSize: 1, maxChunkSize: 1 })
    expect(job.chunks).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 },
      { start: 5, end: 6 },
    ])
    expect(job).toMatchObject(memory)
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.slice(2).map((call) => call.body.cues.map((cue: any) => cue.id))).toEqual([
      [3],
      [4],
      [5],
      [6],
    ])
    expect(h.calls[2].body.context[0].target).toBe('人工修正')
    expect(job.translations[1]).toBe('人工修正')
    expect(job.status).toBe('completed')
    expect(loadWorkspace(h.storage).jobs[0].completedChunks).toBe(5)
  })

  it('starts directly, falls back once per run, and reserves RPM for every attempt with zero retries', async () => {
    const h = harness()
    h.workspace.jobs[0].settings.maxRetries = 0
    const request = h.hooks.request
    h.hooks.request = async (body, signal, transport) => {
      const result = await request(body, signal, transport)
      if (transport === 'direct') throw new DirectConnectionError()
      return result
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.transport)).toEqual(['direct', 'server', 'server', 'server'])
    for (let i = 1; i < h.calls.length; i++)
      expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(3000)
    const job = loadWorkspace(h.storage).jobs[0]
    expect(job.completedChunks).toBe(3)
    expect(job.requests).toBe(4)
    expect(job.status).toBe('completed')
    expect(
      job.events.filter((item) => formatMessage(item.message).includes('将尝试服务器转发')),
    ).toHaveLength(1)
    expect(h.notices).toEqual([])
  })

  it('can pause before fallback and tries the browser again when manually resumed', async () => {
    const h = harness(2)
    const request = h.hooks.request
    let first = true
    h.hooks.request = async (body, signal, transport) => {
      const result = await request(body, signal, transport)
      if (first) {
        first = false
        throw new DirectConnectionError()
      }
      return result
    }
    const sleep = h.hooks.sleep
    h.hooks.sleep = async (ms, signal) => {
      expect(h.runtime.transport).toBe('server')
      h.runner.pause()
      return sleep(ms, signal)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.transport)).toEqual(['direct'])
    expect(h.workspace.jobs[0]).toMatchObject({ status: 'paused', completedChunks: 0, error: '' })
    h.hooks.sleep = sleep
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.transport)).toEqual(['direct', 'direct'])
    expect(h.workspace.jobs[0].status).toBe('completed')
  })

  it.each([
    new APIError('HTTP 401', false),
    new APIError('HTTP 429', true, 7),
    new APIError('timeout', true),
    new APIError('invalid model output', true),
  ])(
    'does not route a readable response, timeout or invalid translation through fallback: $message',
    async (failure) => {
      const h = harness(2)
      h.workspace.jobs[0].settings.maxRetries = 1
      const request = h.hooks.request
      h.hooks.request = async (body, signal, transport) => {
        await request(body, signal, transport)
        throw failure
      }
      await h.runner.run('test-job-1', 'dummy-key')
      expect(h.calls).toHaveLength(failure.retryable ? 2 : 1)
      expect(h.calls.every((call) => call.transport === 'direct')).toBe(true)
      expect(h.workspace.jobs[0].completedChunks).toBe(0)
      expect(h.workspace.jobs[0].error).toBe(failure.message)
    },
  )

  it('rebuilds fallback context from corrections saved while waiting for RPM', async () => {
    const h = harness(4)
    const request = h.hooks.request
    h.hooks.request = async (body, signal, transport) => {
      const result = await request(body, signal, transport)
      if (body.cues[0].id === 3 && transport === 'direct') throw new DirectConnectionError()
      return result
    }
    const sleep = h.hooks.sleep
    h.hooks.sleep = async (ms, signal) => {
      if (h.runtime.transport === 'server') h.workspace.jobs[0].translations[1] = '等待期间的修正'
      return sleep(ms, signal)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.transport)).toEqual(['direct', 'direct', 'server'])
    expect(h.calls[2].body.context[0].target).toBe('等待期间的修正')
    expect(h.calls[2].body.styleNotes).toBe('风格 1')
    expect(h.workspace.jobs[0].status).toBe('completed')
  })

  it('waits through server rate limits after fallback without consuming model retries', async () => {
    const h = harness(2)
    h.workspace.jobs[0].settings.maxRetries = 0
    const request = h.hooks.request
    let serverAttempts = 0
    h.hooks.request = async (body, signal, transport) => {
      const result = await request(body, signal, transport)
      if (transport === 'direct') throw new DirectConnectionError()
      if (serverAttempts++ === 0) throw new APIError('server throttled', true, 9, true)
      return result
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.transport)).toEqual(['direct', 'server', 'server'])
    expect(h.calls[2].at - h.calls[1].at).toBeGreaterThanOrEqual(9000)
    expect(h.workspace.jobs[0].status).toBe('completed')
  })

  it('carries background, glossary, style and translated context through every round while respecting RPM', async () => {
    const h = harness()
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls.map((call) => call.body.cues.map((cue: any) => cue.id))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(3000)
    expect(h.calls[1].body.glossary).toContainEqual({ source: 'term-1', target: '术语 1' })
    expect(h.calls[1].body.styleNotes).toBe('风格 1')
    expect(h.calls[1].body.context[0]).toEqual({ source: 'Source cue 1.', target: '译文 1' })
    expect(h.calls[0].body.futureContext).toEqual([
      { id: 3, text: 'Source cue 3.' },
      { id: 4, text: 'Source cue 4.' },
      { id: 5, text: 'Source cue 5.' },
    ])
    expect(h.calls[1].body.futureContext.map((cue: any) => cue.id)).toEqual([5, 6])
    expect(h.calls[2].body.futureContext).toEqual([])
    expect(h.calls.every((call) => call.body.background === '财务教育背景')).toBe(true)
    const job = loadWorkspace(h.storage).jobs[0]
    expect(job.status).toBe('completed')
    expect(job.completedChunks).toBe(3)
    expect(job.usage.total_tokens).toBe(30)
    expect(job.glossary).toHaveLength(4)
    expect(job.lastGlossarySent).toBe(3)
  })

  it('can independently disable previous and future context', async () => {
    const h = harness(4)
    h.workspace.jobs[0].settings.contextSize = 0
    h.workspace.jobs[0].settings.futureContextSize = 0
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(2)
    expect(
      h.calls.every((call) => call.body.context.length === 0 && call.body.futureContext.length === 0),
    ).toBe(true)
  })

  it('resumes at the first unfinished block without retranslating completed cues', async () => {
    const h = harness(),
      job = h.workspace.jobs[0]
    Object.assign(job, {
      completedChunks: 1,
      translations: { 1: '已保存 1', 2: '已保存 2' },
      styleNotes: '已保存风格',
      status: 'paused',
    })
    await h.runner.run(job.id, 'dummy-key')
    expect(h.calls[0].body.cues[0].id).toBe(3)
    expect(h.calls[0].body.styleNotes).toBe('已保存风格')
    expect(h.calls[0].body.context[0].target).toBe('已保存 1')
    expect(job.translations[1]).toBe('已保存 1')
  })

  it('counts retries toward RPM and persists Retry-After delays', async () => {
    const h = harness(2)
    let attempts = 0
    const base = h.hooks.request
    h.hooks.request = async (body, signal) => {
      const result = await base(body, signal)
      if (attempts++ === 0) throw new APIError('rate limited', true, 7)
      return result
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(7000)
    expect(h.workspace.jobs[0].requests).toBe(2)
    expect(h.workspace.jobs[0].completedChunks).toBe(1)
  })

  it('does not replace a failed block with source text or retry credential failures', async () => {
    const h = harness()
    h.hooks.request = async () => {
      throw new APIError('API Key 无效', false)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    const job = h.workspace.jobs[0]
    expect(job.status).toBe('error')
    expect(job.completedChunks).toBe(0)
    expect(job.translations).toEqual({})
    expect(job.requests).toBe(1)
  })

  it('shares Retry-After even when no retries remain', async () => {
    const h = harness(2)
    h.workspace.jobs[0].settings.maxRetries = 0
    h.hooks.request = async () => {
      throw new APIError('rate limited', true, 12)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.workspace.jobs[0].status).toBe('error')
    expect(h.rate.nextAt).toBeGreaterThanOrEqual(1_012_000)
  })

  it('waits through repeated server throttling without spending the model retry budget', async () => {
    const h = harness(2)
    h.workspace.jobs[0].settings.maxRetries = 0
    const request = h.hooks.request
    let refusals = 0
    h.hooks.request = async (body, signal) => {
      const result = await request(body, signal)
      if (refusals++ < 4) throw new APIError('服务端请求过于频繁或并发已满，请稍后重试', true, 7, true)
      return result
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(5)
    for (let i = 1; i < h.calls.length; i++)
      expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(7000)
    const job = loadWorkspace(h.storage).jobs[0]
    expect(job.status).toBe('completed')
    expect(job.completedChunks).toBe(1)
    expect(job.usage.total_tokens).toBe(10)
    expect(h.notices).toEqual([])
  })

  it('can pause during server throttling and retains the last completed checkpoint', async () => {
    const h = harness(4)
    h.workspace.jobs[0].settings.maxRetries = 0
    const request = h.hooks.request
    const wait = h.hooks.sleep
    let throttled = false
    h.hooks.request = async (body, signal) => {
      const result = await request(body, signal)
      if (body.cues[0].id === 3) {
        throttled = true
        throw new APIError('server throttled', true, 30, true)
      }
      return result
    }
    h.hooks.sleep = async (ms, signal) => {
      if (throttled) {
        expect(h.runtime.phase).toBe('waiting')
        expect(h.runtime.waitReason).toBe('rate')
        h.runner.pause()
      }
      return wait(ms, signal)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    const job = loadWorkspace(h.storage).jobs[0]
    expect(job.status).toBe('paused')
    expect(job.completedChunks).toBe(1)
    expect(job.translations[1]).toBe('译文 1')
    expect(job.translations[3]).toBeUndefined()
    expect(h.calls).toHaveLength(2)
    expect(job.error).toBe('')
    expect(h.rate.nextAt).toBeGreaterThanOrEqual(h.calls[1].at + 30000)
  })

  it('does not reset genuine model failure attempts after a server throttle', async () => {
    const h = harness(2)
    h.workspace.jobs[0].settings.maxRetries = 1
    const request = h.hooks.request
    let count = 0
    h.hooks.request = async (body, signal) => {
      await request(body, signal)
      if (++count === 2) throw new APIError('server throttled', true, 7, true)
      throw new APIError('model failed', true)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(3)
    expect(h.workspace.jobs[0].status).toBe('error')
    expect(h.workspace.jobs[0].error).toBe('model failed')
    expect(h.workspace.jobs[0].completedChunks).toBe(0)
  })

  it('rechecks an elapsed wake-up time instead of mistaking it for a reserved request', async () => {
    const h = harness(2)
    let reservations = 0
    const reserve = h.hooks.reserve
    h.hooks.reserve = async (job) => {
      if (++reservations === 1) return 999_000
      return reserve(job)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(reservations).toBe(2)
    expect(h.calls).toHaveLength(1)
  })

  it('finishes and saves the in-flight block before honoring pause', async () => {
    const h = harness()
    const base = h.hooks.request
    h.hooks.request = async (body, signal) => {
      h.runner.pause()
      expect(signal.aborted).toBe(false)
      return base(body, signal)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(1)
    const job = loadWorkspace(h.storage).jobs[0]
    expect(job.status).toBe('paused')
    expect(job.completedChunks).toBe(1)
    expect(job.styleNotes).toBe('风格 1')
    expect(job.glossary).toHaveLength(2)
    expect(job.lastGlossarySent).toBe(1)
  })

  it('can pause immediately during a rate-limit wait', async () => {
    const h = harness()
    h.hooks.sleep = async (ms, signal) => {
      h.runner.pause()
      return sleep(ms, signal)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(1)
    expect(h.workspace.jobs[0].status).toBe('paused')
  })

  it('stops sending requests when a checkpoint cannot be persisted and retains results in memory', async () => {
    const h = harness()
    h.hooks.save = () => {
      if (h.workspace.jobs[0].completedChunks > 0) throw new StorageError('storage full')
      saveWorkspace(h.storage, h.workspace)
    }
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls).toHaveLength(1)
    expect(h.workspace.jobs[0].status).toBe('paused')
    expect(h.workspace.jobs[0].translations[2]).toBe('译文 2')
    expect(loadWorkspace(h.storage).jobs[0].completedChunks).toBe(0)
    expect(h.notices).toContain('storage full')
  })

  it('honors a persisted request reservation after a refresh', async () => {
    const h = harness(2)
    h.rate.nextAt = 1_030_000
    await h.runner.run('test-job-1', 'dummy-key')
    expect(h.calls[0].at).toBeGreaterThanOrEqual(1_030_000)
  })
})
