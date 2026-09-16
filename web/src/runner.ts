import { errorMessage, message, type Message } from './messages'
import { APIError, DirectConnectionError } from './transport'
import { GLOSSARY_HISTORY_LIMIT, StorageError } from './storage'
import {
  event,
  type Job,
  type TranslationRequest,
  type TranslationResult,
  type TranslationTransport,
  type Workspace,
} from './types'

export interface Runtime {
  activeJobId: string
  phase: 'idle' | 'queued' | 'requesting' | 'waiting' | 'pausing'
  waitReason?: 'rate' | 'retry'
  waitUntil: number
  attempt: number
  pauseRequested: boolean
  transport?: TranslationTransport
}
export interface RunnerHooks {
  workspace(): Workspace
  save(job: Job): void | Promise<void>
  reserve(job: Job): Promise<number>
  cooldown(until: number): Promise<void>
  changed?(): Promise<void>
  request(
    body: TranslationRequest,
    signal: AbortSignal,
    transport: TranslationTransport,
  ): Promise<TranslationResult>
  notify(message: Message): void
  now?(): number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

class Paused extends Error {}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Paused())
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new Paused())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class Runner {
  private delayAbort = new AbortController()
  private requestAbort = new AbortController()
  private discarded = false
  private readonly now: () => number
  constructor(
    public runtime: Runtime,
    private hooks: RunnerHooks,
  ) {
    this.now = hooks.now ?? Date.now
  }

  pause(): void {
    this.runtime.pauseRequested = true
    if (this.runtime.phase === 'requesting') this.runtime.phase = 'pausing'
    this.delayAbort.abort()
  }

  stop(): void {
    this.discarded = true
    this.pause()
    this.requestAbort.abort()
  }

  private async wait(until: number, reason: 'rate' | 'retry' = 'rate'): Promise<void> {
    if (until > this.now()) {
      this.runtime.phase = 'waiting'
      this.runtime.waitUntil = until
      this.runtime.waitReason = reason
      await this.hooks.changed?.()
      while (until > this.now()) {
        if (this.runtime.pauseRequested) throw new Paused()
        await (this.hooks.sleep ?? sleep)(Math.min(until - this.now(), 1000), this.delayAbort.signal)
      }
    }
    this.runtime.waitUntil = 0
    this.runtime.waitReason = undefined
    if (this.runtime.pauseRequested) throw new Paused()
  }

  async run(id: string, apiKey: string): Promise<void> {
    const workspace = this.hooks.workspace()
    const job = workspace.jobs.find((job) => job.id === id)
    if (!job || job.completedChunks === job.chunks.length) return
    this.delayAbort = new AbortController()
    this.requestAbort = new AbortController()
    this.discarded = false
    Object.assign(this.runtime, {
      activeJobId: id,
      phase: 'idle',
      pauseRequested: false,
      waitUntil: 0,
      attempt: 0,
      transport: 'direct',
    })
    try {
      job.status = 'paused'
      job.error = ''
      event(
        job,
        job.completedChunks
          ? message('从第 {0} 块继续翻译', { 0: job.completedChunks + 1 })
          : '翻译任务已开始',
      )
      await this.hooks.save(job)
      while (job.completedChunks < job.chunks.length) {
        if (this.runtime.pauseRequested) throw new Paused()
        const chunk = job.chunks[job.completedChunks]
        let result: TranslationResult | undefined
        let retryAt = 0
        let retryReason: 'rate' | 'retry' = 'retry'
        for (let attempt = 0; attempt <= job.settings.maxRetries;) {
          this.runtime.attempt = attempt
          await this.wait(retryAt, retryReason)
          while (true) {
            const due = await this.hooks.reserve(job)
            if (this.runtime.pauseRequested) throw new Paused()
            if (due === 0) break
            await this.wait(due)
          }
          if (this.discarded) throw new Paused()
          job.requests++
          await this.hooks.save(job)
          this.runtime.phase = 'requesting'
          await this.hooks.changed?.()
          if (this.runtime.pauseRequested) {
            job.requests--
            throw new Paused()
          }
          try {
            result = await this.hooks.request(
              {
                ...job.profile,
                apiKey,
                sourceLanguage: job.settings.sourceLanguage,
                targetLanguage: job.settings.targetLanguage,
                background: job.settings.background,
                styleNotes: job.styleNotes,
                glossary: job.glossary,
                cues: job.document.cues.slice(chunk.start, chunk.end).map(({ id, text }) => ({ id, text })),
                context: job.document.cues
                  .slice(Math.max(0, chunk.start - job.settings.contextSize), chunk.start)
                  .map((cue) => ({ source: cue.text, target: job.translations[cue.id] ?? '' })),
                futureContext: job.document.cues
                  .slice(chunk.end, chunk.end + job.settings.futureContextSize)
                  .map(({ id, text }) => ({ id, text })),
                temperature: job.settings.temperature,
                maxTokens: job.settings.maxTokens,
                timeoutSeconds: job.settings.timeoutSeconds,
              },
              this.requestAbort.signal,
              this.runtime.transport ?? 'direct',
            )
            break
          } catch (error) {
            if (this.discarded) throw new Paused()
            const failure = this.requestAbort.signal.aborted
              ? new APIError('请求超时，已保留完成的进度', true)
              : error
            this.requestAbort = new AbortController()
            // Retry-After applies to the credential even if this task has no
            // retries left or was paused while the response was in flight.
            if (failure instanceof APIError && failure.retryAfter > 0)
              await this.hooks.cooldown(this.now() + failure.retryAfter * 1000)
            if (this.runtime.pauseRequested) throw new Paused()
            if (failure instanceof DirectConnectionError && this.runtime.transport === 'direct') {
              // Retry this block over the server route, reserving a fresh RPM
              // slot above. The route remains stable until this run ends;
              // manually resuming a task tries the browser again.
              this.runtime.transport = 'server'
              retryAt = 0
              event(job, errorMessage(failure), 'warning')
              await this.hooks.save(job)
              await this.hooks.changed?.()
              continue
            }
            if (failure instanceof APIError && failure.rateLimited) {
              // Local admission refusals have not reached the model. Wait for
              // capacity without consuming the model-failure retry budget.
              retryAt = this.now() + Math.max(1000, failure.retryAfter * 1000)
              retryReason = 'rate'
              event(job, errorMessage(failure), 'warning')
              await this.hooks.save(job)
              continue
            }
            if (!(failure instanceof APIError) || !failure.retryable || attempt === job.settings.maxRetries)
              throw failure
            retryAt = this.now() + Math.max(failure.retryAfter * 1000, 2000 * 2 ** attempt)
            retryReason = 'retry'
            event(
              job,
              message('第 {0} 块：{1}；准备第 {2} 次重试', {
                0: job.completedChunks + 1,
                1: errorMessage(failure),
                2: attempt + 1,
              }),
              'warning',
            )
            await this.hooks.save(job)
            attempt++
          }
        }
        if (this.discarded) throw new Paused()
        if (!result) throw new Error('未收到翻译结果')
        // A checkpoint contains the entire block, its glossary, and its style
        // memo in ONE localStorage write. Never save a partial block.
        const translations = { ...job.translations }
        for (const line of result.translations) translations[line.id] = line.text
        job.translations = translations
        job.glossary = result.glossary
        job.lastGlossarySent = result.glossarySent
        job.styleNotes = result.styleNotes
        job.completedChunks++
        job.glossaryHistory.push({ chunk: job.completedChunks, at: this.now(), terms: result.glossaryUsed })
        if (job.glossaryHistory.length > GLOSSARY_HISTORY_LIMIT)
          job.glossaryHistory.splice(0, job.glossaryHistory.length - GLOSSARY_HISTORY_LIMIT)
        for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const)
          job.usage[field] += Math.max(0, result.usage?.[field] ?? 0)
        event(
          job,
          message('第 {0} / {1} 块已完成，{2} 条译文；本轮携带 {3} 条术语', {
            0: job.completedChunks,
            1: job.chunks.length,
            2: chunk.end - chunk.start,
            3: result.glossarySent,
          }),
          'success',
        )
        for (const warning of result.warnings ?? []) event(job, warning, 'warning')
        job.updatedAt = this.now()
        if (job.completedChunks === job.chunks.length) {
          job.status = 'completed'
          event(job, '全部翻译完成，可以校对并下载字幕', 'success')
        }
        await this.hooks.save(job)
      }
    } catch (error) {
      if (!this.discarded) {
        job.status =
          job.completedChunks === job.chunks.length
            ? 'completed'
            : error instanceof Paused || error instanceof StorageError
              ? 'paused'
              : 'error'
        job.error = error instanceof Paused ? '' : errorMessage(error)
        event(
          job,
          error instanceof Paused ? '已暂停，继续时会从最近完成的分块开始' : job.error,
          error instanceof Paused ? 'info' : 'error',
        )
        job.updatedAt = this.now()
        try {
          await this.hooks.save(job)
        } catch {
          /* the caller surfaces the storage error and keeps the in-memory checkpoint */
        }
        if (job.error) this.hooks.notify(job.error)
      }
    } finally {
      Object.assign(this.runtime, {
        activeJobId: '',
        phase: 'idle',
        waitUntil: 0,
        pauseRequested: false,
        attempt: 0,
        transport: undefined,
      })
    }
  }
}
