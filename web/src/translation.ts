import { message, type Message, type MessageKey } from './messages'
import systemPrompt from './system_prompt.txt?raw'
import { post, serverError, APIError, DirectConnectionError } from './transport'
import { selectGlossary, termMatcher } from './glossary'
import { byteLength, cleanText, inlineTags, termKey, trimSpace } from './text'
import { boundedText, limits, normalizeTranslation } from './validation'
import type { Term, TranslationRequest, TranslationResult, TranslationTransport, Usage } from './types'

const maximumResponseBytes = 2 * 1024 * 1024

function requireValue(condition: unknown, message: Message, retryable = false): asserts condition {
  if (!condition) throw new APIError(message, retryable)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function directEndpoint(base: string): string {
  let url: URL
  try {
    url = new URL(base.trim())
  } catch {
    throw new APIError('请填写不含账号、查询参数或片段的 API Base URL')
  }
  requireValue(
    url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      boundedText(base, limits.baseUrl),
    '请填写不含账号、查询参数或片段的 API Base URL',
  )
  requireValue(['https:', 'http:'].includes(url.protocol), 'API 地址必须使用 HTTP 或 HTTPS')
  // No deployment allowlist applies here. CORS, mixed-content and local-network
  // permissions remain the browser's responsibility.
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions'
  return url.href
}

function validateRequest(req: TranslationRequest): void {
  requireValue(
    req.apiKey.trim() && boundedText(req.apiKey, limits.apiKey) && !/[^\x20-\x7e]/.test(req.apiKey),
    '请填写有效的 API Key',
  )
  requireValue(req.model.trim() && boundedText(req.model, limits.model), '请填写有效的模型名称')
  requireValue(
    req.sourceLanguage &&
      req.targetLanguage &&
      boundedText(req.sourceLanguage, limits.language) &&
      boundedText(req.targetLanguage, limits.language),
    '请选择源语言和目标语言',
  )
  requireValue(
    req.cues.length >= 1 &&
      req.cues.length <= 100 &&
      req.context.length <= 20 &&
      req.futureContext.length <= 20,
    '每块需包含 1～100 条字幕，前文与后文各最多 20 条',
  )
  const seen = new Set<number>()
  let size = 0
  for (const [lines, message] of [
    [req.cues, '字幕块包含无效或重复的条目'],
    [req.futureContext, '后文包含无效或重复的字幕条目'],
  ] as const) {
    for (const cue of lines) {
      requireValue(
        Number.isSafeInteger(cue.id) &&
          cue.id > 0 &&
          !seen.has(cue.id) &&
          trimSpace(cue.text) &&
          boundedText(cue.text, limits.source),
        message,
      )
      seen.add(cue.id)
      size += byteLength(cue.text)
    }
  }
  for (const line of req.context) size += byteLength(line.source) + byteLength(line.target)
  requireValue(
    size <= 180000 &&
      boundedText(req.background, limits.background) &&
      boundedText(req.styleNotes, limits.style),
    '字幕块、上下文或背景设定过长，请减小分块',
  )
  const keys = new Set<string>()
  for (const term of req.glossary) {
    const key = termKey(term.source)
    requireValue(
      key &&
        trimSpace(term.target) &&
        boundedText(term.source, limits.termSource) &&
        boundedText(term.target, limits.termTarget) &&
        boundedText(term.note ?? '', limits.termNote) &&
        !keys.has(key),
      '术语库包含空白、重复或过长的术语',
    )
    keys.add(key)
  }
  requireValue(
    req.temperature === null ||
      (Number.isFinite(req.temperature) && req.temperature >= 0 && req.temperature <= 2),
    'Temperature 必须在 0～2 之间',
  )
  requireValue(
    Number.isInteger(req.maxTokens) &&
      req.maxTokens >= 256 &&
      req.maxTokens <= 32768 &&
      Number.isInteger(req.timeoutSeconds) &&
      req.timeoutSeconds >= 10 &&
      req.timeoutSeconds <= 180,
    '输出 Token 上限或请求超时设置无效',
  )
  requireValue(
    ['max_tokens', 'max_completion_tokens'].includes(req.tokenParameter),
    '输出 Token 参数名称无效',
  )
}

export function prepareTranslation(req: TranslationRequest) {
  validateRequest(req)
  const endpoint = directEndpoint(req.baseUrl)
  const glossary = selectGlossary(req)
  const payload: Record<string, unknown> = {
    model: req.model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          source_language: req.sourceLanguage,
          target_language: req.targetLanguage,
          background: req.background,
          established_style_notes: req.styleNotes,
          established_glossary: glossary,
          previous_context: req.context,
          future_context: req.futureContext,
          cues_to_translate: req.cues,
        }),
      },
    ],
    [req.tokenParameter]: req.maxTokens,
  }
  if (req.temperature !== null) payload.temperature = req.temperature
  return { endpoint, payload, glossary }
}

export function parseTranslation(
  raw: string,
  req: TranslationRequest,
  glossaryUsed: Term[],
): TranslationResult {
  raw = trimSpace(raw)
  for (const prefix of ['```json\n', '```\n']) {
    if (raw.startsWith(prefix) && raw.endsWith('```')) {
      raw = trimSpace(raw.slice(prefix.length, -3))
      break
    }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    /* report the protocol error below */
  }
  requireValue(
    record(decoded) && Array.isArray(decoded.translations),
    '模型输出需要包含有效的 translations 数组',
    true,
  )
  requireValue(
    decoded.translations.length === req.cues.length,
    message('译文条数不匹配：需要 {0} 条，收到 {1} 条', {
      0: req.cues.length,
      1: decoded.translations.length,
    }),
    true,
  )
  const expected = new Map(req.cues.map((cue) => [cue.id, cue]))
  const byID = new Map<number, string>()
  for (const line of decoded.translations) {
    requireValue(
      record(line) && typeof line.id === 'number' && typeof line.text === 'string',
      '译文包含缺失、重复、未知编号或空白条目',
      true,
    )
    const cue = expected.get(line.id)
    const text = cleanText(line.text)
    requireValue(
      cue && !byID.has(line.id) && text.trim() && boundedText(text, limits.translation),
      '译文包含缺失、重复、未知编号或空白条目',
      true,
    )
    requireValue(
      JSON.stringify(cue.text.match(inlineTags) ?? []) === JSON.stringify(text.match(inlineTags) ?? []),
      message('第 {0} 条译文改变了字幕格式标签，将重新请求', { 0: cue.id }),
      true,
    )
    byID.set(line.id, normalizeTranslation(text))
  }
  const glossary = req.glossary.map((term) => ({ ...term }))
  const known = new Map(glossary.map((term) => [termKey(term.source), term.target]))
  const inCurrentSource = termMatcher(req.cues.map((cue) => cue.text).join(' '))
  const warnings: Message[] = []
  const newTerms = Array.isArray(decoded.glossary) ? decoded.glossary : []
  if (!Array.isArray(decoded.glossary)) warnings.push('本轮术语字段无效，已保留译文和已有术语库')
  if (newTerms.length > limits.newTerms) warnings.push('本轮新增术语超过 40 条，已忽略超出部分并保留译文')
  let invalidTerms = 0
  let unmatchedTerms = 0
  for (const value of newTerms.slice(0, limits.newTerms)) {
    if (!(
      record(value) &&
      typeof value.source === 'string' &&
      typeof value.target === 'string' &&
      (value.note == null || typeof value.note === 'string')
    )) {
      invalidTerms++
      continue
    }
    const source = trimSpace(value.source),
      target = trimSpace(value.target),
      note = trimSpace((value.note as string | undefined) ?? '')
    const key = termKey(source)
    if (!(
      source.trim() &&
      key &&
      target.trim() &&
      boundedText(source, limits.termSource) &&
      boundedText(target, limits.termTarget) &&
      boundedText(note, limits.termNote)
    )) {
      invalidTerms++
      continue
    }
    if (known.has(key)) {
      const old = known.get(key)!
      if (old !== target) warnings.push(message('术语「{0}」沿用已有译法「{1}」', { 0: source, 1: old }))
      continue
    }
    // Only new model terms need source evidence. User terms and the existing
    // master can refer to other chunks and must remain intact.
    if (!inCurrentSource(source)) {
      unmatchedTerms++
      continue
    }
    known.set(key, target)
    glossary.push({ source, target, ...(note ? { note } : {}) })
  }
  if (invalidTerms) warnings.push(message('本轮跳过 {0} 条无效术语，译文已保留', { 0: invalidTerms }))
  if (unmatchedTerms)
    warnings.push(message('本轮跳过 {0} 条未在当前块原文中找到的术语，译文已保留', { 0: unmatchedTerms }))
  const validStyle = boundedText(decoded.style_notes, limits.style)
  const style = validStyle ? trimSpace(decoded.style_notes as string) : ''
  if (!validStyle) warnings.push('本轮风格备忘无效，已保留译文并沿用上一轮风格')
  return {
    translations: req.cues.map((cue) => ({ id: cue.id, text: byID.get(cue.id)! })),
    glossary,
    glossaryUsed,
    glossarySent: glossaryUsed.length,
    warnings,
    styleNotes: style || req.styleNotes,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0
  if (/^\d+$/.test(value.trim())) return Math.min(3600, Number(value))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.min(3600, Math.floor((date - now) / 1000) + 1)) : 0
}

function upstreamError(response: Response): APIError {
  const keys: Record<number, MessageKey> = {
    401: '模型接口返回 HTTP {0}，请检查 API Key 和模型权限',
    403: '模型接口返回 HTTP {0}，请检查 API Key 和模型权限',
    404: '模型接口返回 HTTP {0}，请检查接口地址和模型名称',
    429: '模型接口返回 HTTP {0}，已触发限流，将按等待时间重试',
    400: '模型接口返回 HTTP {0}，请检查模型名称、Token 参数和 Temperature 设置',
    422: '模型接口返回 HTTP {0}，请检查模型名称、Token 参数和 Temperature 设置',
  }
  return new APIError(
    message(keys[response.status] ?? '模型接口返回 HTTP {0}', { 0: response.status }),
    response.status === 429 || response.status === 408 || response.status >= 500,
    retryAfter(response.headers.get('Retry-After')),
  )
}

async function readCompletion(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    requireValue(
      reader && Number(response.headers.get('Content-Length') ?? 0) <= maximumResponseBytes,
      '模型响应读取失败或超过 2 MB',
      true,
    )
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      requireValue(size <= maximumResponseBytes, '模型响应读取失败或超过 2 MB', true)
      chunks.push(value)
    }
  } catch {
    await reader?.cancel().catch(() => {})
    throw new APIError('模型响应读取失败或超过 2 MB', true)
  } finally {
    reader?.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    /* validated below */
  }
  requireValue(record(data), '模型接口没有返回有效的 Chat Completions 响应', true)
  return data
}

export async function translate(
  req: TranslationRequest,
  signal: AbortSignal,
  transport: TranslationTransport = 'direct',
): Promise<TranslationResult> {
  const { endpoint, payload, glossary } = prepareTranslation(req)
  if (signal.aborted) throw new APIError('请求已中断')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timeout = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    (req.timeoutSeconds + (transport === 'server' ? 8 : 0)) * 1000,
  )
  try {
    let response: Response
    if (transport === 'server') {
      response = await post(
        'relay',
        {
          baseUrl: req.baseUrl,
          apiKey: req.apiKey,
          payload,
          timeoutSeconds: req.timeoutSeconds,
        },
        controller.signal,
      )
      if (response.headers.get('X-Muyu-Upstream') !== 'true') throw await serverError(response)
    } else
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'Bearer ' + req.apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
      } catch {
        throw new DirectConnectionError()
      }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {})
      throw upstreamError(response)
    }
    const completion = await readCompletion(response)
    const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined
    requireValue(
      record(first) && record(first.message) && typeof first.message.content === 'string',
      '模型接口没有返回有效的 Chat Completions 响应',
      true,
    )
    requireValue(
      first.finish_reason !== 'length',
      '模型输出被 Token 上限截断，请增大输出上限或减小分块',
      false,
    )
    const result = parseTranslation(first.message.content, req, glossary)
    if (record(completion.usage)) {
      for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as (keyof Usage)[]) {
        const value = completion.usage[field]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          result.usage[field] = value
      }
    }
    return result
  } catch (error) {
    // An explicit abort or timeout never launches another request by fallback.
    if (signal.aborted) throw new APIError('请求已中断')
    if (timedOut) throw new APIError('模型请求超时，可以增大超时或减小字幕块', true)
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
