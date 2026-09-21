import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from './testdata/translation_protocol.json'
import systemPrompt from './system_prompt.txt?raw'
import { APIError, DirectConnectionError } from './transport'
import { glossaryCharacterBudget, selectGlossary } from './glossary'
import {
  directEndpoint,
  parseTranslation,
  prepareTranslation,
  retryAfter,
  translate,
  translationSystemPrompt,
} from './translation'
import type { TranslationRequest } from './types'

const request = () => structuredClone(fixtures[0].request) as TranslationRequest
const signal = () => new AbortController().signal
const completion = () => structuredClone(fixtures[0].completion)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('translation protocol', () => {
  it('keeps local glossary identities out of the model payload', () => {
    const req = request()
    req.glossary.forEach((term, index) => {
      term.id = `local-only-${index}`
    })
    expect(JSON.stringify(prepareTranslation(req).payload)).not.toContain('local-only-')
  })
  it.each(fixtures)('$name', async (fixture) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.completion)))
    vi.stubGlobal('fetch', fetch)
    const req = structuredClone(fixture.request) as TranslationRequest
    expect(await translate(req, signal())).toEqual(fixture.expected)
    expect(req).toEqual(fixture.request)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe('https://custom-model.example/v1/chat/completions')
    expect(options).toMatchObject({
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    expect(options.headers.Authorization).toBe('Bearer ' + req.apiKey)
    const body = JSON.parse(options.body)
    expect(body.messages[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(JSON.parse(body.messages[1].content)).toEqual({
      source_language: req.sourceLanguage,
      target_language: req.targetLanguage,
      background: req.background,
      established_style_notes: req.styleNotes,
      established_glossary: fixture.expected.glossaryUsed,
      previous_context: req.context,
      future_context: req.futureContext,
      cues_to_translate: req.cues,
    })
    expect(body[req.tokenParameter]).toBe(req.maxTokens)
    expect(body[req.tokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined()
    expect(body.temperature).toBe(req.temperature ?? undefined)
    expect(options.body).not.toContain(req.apiKey)
  })

  it('bounds the prompt subset while retaining and growing a master beyond 400 terms', () => {
    const req = request()
    req.glossary = Array.from({ length: 1000 }, (_, i) => ({
      source: `专名${i}号`,
      target: `译名${i}`,
      note: '细节'.repeat(80),
      locked: true,
    }))
    req.context = [{ source: req.glossary.map((term) => term.source).join(' '), target: '' }]
    req.glossary.push({ source: 'Project Nova', target: '新星计划', note: '', locked: true })
    const before = structuredClone(req.glossary)
    const selected = prepareTranslation(req).glossary
    expect(selected[0].source).toBe('Project Nova')
    expect(selected.length).toBeGreaterThan(1)
    expect(selected.length).toBeLessThan(req.glossary.length)
    expect(Array.from(JSON.stringify(selected)).length).toBeLessThanOrEqual(glossaryCharacterBudget)
    expect(req.glossary).toEqual(before)
    expect(selectGlossary(req)).toEqual(selected)
    const result = parseTranslation(completion().choices[0].message.content, req, selected)
    expect(result.glossary).toHaveLength(before.length + 1)
    expect(result.glossary.at(-1)).toEqual({ source: 'Ann', target: '安妮' })
    expect(result.warnings).toEqual([])
  })

  it('omits glossary from the prompt and does not merge returned terms when glossary is off', () => {
    const req = request()
    req.useGlossary = false
    req.glossary = [
      { source: 'cash flow', target: '现金流', locked: true },
      { source: 'Project Nova', target: '新星计划', locked: true },
    ]
    const prepared = prepareTranslation(req)
    expect(prepared.glossary).toEqual([])
    expect(prepared.payload.messages[0]).toEqual({
      role: 'system',
      content: translationSystemPrompt(false),
    })
    expect(JSON.parse(prepared.payload.messages[1].content as string).established_glossary).toEqual([])
    const response = JSON.parse(completion().choices[0].message.content)
    response.glossary = [{ source: 'Ann', target: '安妮' }]
    const result = parseTranslation(JSON.stringify(response), req, [])
    expect(result.glossary).toEqual(req.glossary)
    expect(result.glossaryUsed).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('skips new terms from translations or auxiliary context without losing translations or retrying', async () => {
    const req = request()
    req.glossary = [{ source: 'Established Project', target: '既定计划', locked: true }]
    req.context = [{ source: 'Previous Project is complete.', target: '前期项目已经完成。' }]
    req.futureContext = [{ id: 10, text: 'Future Project comes next.' }]
    req.background = 'Background Project is part of the setting.'
    req.styleNotes = 'Keep the Style Project name.'
    const before = structuredClone(req)
    const response = completion()
    const value = JSON.parse(response.choices[0].message.content)
    value.glossary = [
      { source: 'Project Nova', target: '新星计划' },
      { source: '新星计划', target: '新星计划' },
      { source: 'Previous Project', target: '前期项目' },
      { source: '前期项目', target: '前期项目' },
      { source: 'Future Project', target: '未来项目' },
      { source: 'Background Project', target: '背景项目' },
      { source: 'Style Project', target: '风格项目' },
      { source: '既定计划', target: '既定计划' },
      { source: 'Established Project', target: '不覆盖已有译法' },
    ]
    response.choices[0].message.content = JSON.stringify(value)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetch)
    const result = await translate(req, signal())
    expect(result.glossary).toEqual([...req.glossary, { source: 'Project Nova', target: '新星计划' }])
    expect(result.translations).toEqual(fixtures[0].expected.translations)
    expect(result.warnings).toContainEqual({
      key: '本轮跳过 {0} 条未在当前块原文中找到的术语，译文已保留',
      params: { 0: 7 },
    })
    expect(result.warnings).toContainEqual({
      key: '术语「{0}」沿用已有译法「{1}」',
      params: { 0: 'Established Project', 1: '既定计划' },
    })
    expect(req).toEqual(before)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Meet <i>ANN</i> tomorrow.', 'ann', '安'],
    ['The A&amp;B\nInstitute opens.', 'A&B   Institute', '甲乙研究所'],
    ['请前往玄武门集合。', '玄武门', '玄武门'],
    ['エレンは調査兵団に入った。', '調査兵団', '调查兵团'],
    ['그들은 서울에서 만났다.', '서울', '首尔'],
    ['وصلنا إلى قلعة النور؟', 'قلعة النور', '光之城堡'],
  ])('accepts normalized and multilingual source terms: %s / %s', (text, source, target) => {
    const req = request()
    req.cues = [{ id: 1, text }]
    req.glossary = []
    const term = { source, target }
    const result = parseTranslation(
      JSON.stringify({ translations: req.cues, glossary: [term], style_notes: '' }),
      req,
      [],
    )
    expect(result.glossary).toEqual([term])
    expect(result.warnings).toEqual([])
  })

  it('rejects partial word matches even when the same name appears in previous context', () => {
    const req = request()
    req.cues = [{ id: 1, text: 'The annual report mentions Anna.' }]
    req.context = [{ source: 'Ann was here.', target: '安曾经来过。' }]
    req.glossary = []
    const result = parseTranslation(
      JSON.stringify({
        translations: [{ id: 1, text: '年度报告提到了安娜。' }],
        glossary: [{ source: 'Ann', target: '安' }],
        style_notes: '',
      }),
      req,
      [],
    )
    expect(result.glossary).toEqual([])
    expect(result.warnings).toEqual([
      { key: '本轮跳过 {0} 条未在当前块原文中找到的术语，译文已保留', params: { 0: 1 } },
    ])
  })

  it.each([
    ['https://not-on-server-list.example', 'https://not-on-server-list.example/chat/completions'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/chat/completions'],
    ['http://192.168.1.10:11434/v1', 'http://192.168.1.10:11434/v1/chat/completions'],
    ['https://custom.example/chat/completions/', 'https://custom.example/chat/completions'],
  ])('accepts a browser API URL without a hostname allowlist: %s', (base, expected) => {
    expect(directEndpoint(base)).toBe(expected)
  })

  it('rejects invalid protocols, URL credentials and control characters before contacting an API', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const base of [
      'javascript:alert(1)',
      'ftp://model.example/v1',
      'https://user:pass@model.example/v1',
      'https://model.example/v1?key=secret',
    ])
      expect(() => directEndpoint(base)).toThrow(APIError)
    const req = request()
    req.apiKey = 'key\nheader'
    await expect(translate(req, signal())).rejects.toMatchObject({ retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['duplicate', 'markup'])('rejects invalid %s without mutating the checkpoint', (failure) => {
    const req = request()
    const before = structuredClone(req)
    const value = JSON.parse(completion().choices[0].message.content)
    if (failure === 'duplicate') value.translations[0].id = value.translations[1].id
    if (failure === 'markup') value.translations[1].text = '格式标签丢失'
    expect(() => parseTranslation(JSON.stringify(value), req, [])).toThrow(APIError)
    expect(req).toEqual(before)
  })

  it.each([
    undefined,
    null,
    'not a glossary',
    [null],
    [{ source: null, target: '空' }],
    [{ source: '', target: '空' }],
    [{ source: '\ufeff', target: '空' }],
    [{ source: 'Project Nova' }],
    [{ source: 'Project Nova', target: null }],
    [{ source: 'Project Nova', target: '' }],
    [{ source: 'Project Nova', target: ' \t\n\u00a0' }],
  ])('keeps valid translations when the glossary is invalid: %j', (glossary) => {
    const req = request()
    const before = structuredClone(req)
    const value = JSON.parse(completion().choices[0].message.content)
    value.glossary = glossary
    value.style_notes = 'still valid'
    const result = parseTranslation(JSON.stringify(value), req, [])
    expect(result.translations).toHaveLength(req.cues.length)
    expect(result.glossary).toEqual(req.glossary)
    expect(result.styleNotes).toBe('still valid')
    expect(result.warnings).not.toHaveLength(0)
    expect(req).toEqual(before)
  })

  it.each([undefined, null, 10, '长'.repeat(2001)])(
    'retains the previous style for malformed or overlong style notes',
    (style) => {
      const req = request()
      const value = JSON.parse(completion().choices[0].message.content)
      value.style_notes = style
      const result = parseTranslation(JSON.stringify(value), req, [])
      expect(result.styleNotes).toBe(req.styleNotes)
      expect(result.translations).toHaveLength(req.cues.length)
      expect(result.glossary.length).toBeGreaterThan(req.glossary.length)
      expect(result.warnings).toContain('本轮风格备忘无效，已保留译文并沿用上一轮风格')
    },
  )

  it('merges valid new terms while skipping malformed and excess entries without mutating the master', () => {
    const req = request()
    const value = JSON.parse(completion().choices[0].message.content)
    value.glossary = [
      { source: 'New Term', target: '新术语' },
      { source: 'bad', target: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({ source: `Term ${i}`, target: '译文' })),
    ]
    req.cues[0].text += ' ' + value.glossary.map((term: { source: string }) => term.source).join('. ')
    const before = structuredClone(req)
    const result = parseTranslation(JSON.stringify(value), req, [])
    expect(result.glossary.find((term) => term.source === 'New Term')?.target).toBe('新术语')
    expect(result.glossary.find((term) => term.source === 'bad')).toBeUndefined()
    expect(result.glossary.find((term) => term.source === 'Term 39')).toBeUndefined()
    expect(result.warnings).toHaveLength(2)
    expect(req).toEqual(before)
  })
})

describe('direct transport and fallback boundary', () => {
  it('marks a fetch connection failure as eligible for server fallback', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('a URL or key must not appear in the UI'))
    vi.stubGlobal('fetch', fetch)
    await expect(translate(request(), signal())).rejects.toBeInstanceOf(DirectConnectionError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 429, 503])(
    'keeps an HTTP %s response on the direct route and hides the upstream body',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('upstream secret details', { status, headers: { 'Retry-After': '7' } }),
        )
      vi.stubGlobal('fetch', fetch)
      const error = await translate(request(), signal()).catch((error) => error)
      expect(error).toBeInstanceOf(APIError)
      expect(error).not.toBeInstanceOf(DirectConnectionError)
      expect(error.message).not.toContain('upstream secret')
      expect(error.retryable).toBe(status === 429 || status === 503)
      expect(error.retryAfter).toBe(7)
      expect(error.rateLimited).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('aborts without starting server fallback', async () => {
    const controller = new AbortController()
    const fetch = vi
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(new TypeError('aborted'))),
          ),
      )
    vi.stubGlobal('fetch', fetch)
    const pending = translate(request(), controller.signal).catch((error) => error)
    controller.abort()
    const error = await pending
    expect(error).toMatchObject({ message: '请求已中断', retryable: false })
    expect(error).not.toBeInstanceOf(DirectConnectionError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('times out without launching an immediate duplicate through the server', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(new TypeError('aborted'))),
          ),
      )
    vi.stubGlobal('fetch', fetch)
    const req = { ...request(), timeoutSeconds: 10 }
    const pending = translate(req, signal()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(10000)
    const error = await pending
    expect(error).toMatchObject({ retryable: true })
    expect(error).not.toBeInstanceOf(DirectConnectionError)
    expect(error.message).toContain('超时')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not treat a broken response body as a CORS or connection refusal', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('connection lost after headers'))
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)))
    const error = await translate(request(), signal()).catch((error) => error)
    expect(error).toMatchObject({ message: '模型响应读取失败或超过 2 MB', retryable: true })
    expect(error).not.toBeInstanceOf(DirectConnectionError)
  })

  it('bounds streamed responses and rejects truncated model output', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    const data = completion()
    data.choices[0].finish_reason = 'length'
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(data)))
    vi.stubGlobal('fetch', fetch)
    await expect(translate(request(), signal())).rejects.toMatchObject({
      message: '模型响应读取失败或超过 2 MB',
      retryable: true,
    })
    await expect(translate(request(), signal())).rejects.toMatchObject({
      message: '模型输出被 Token 上限截断，请增大输出上限或减小分块',
      retryable: false,
    })
  })

  it.each(fixtures)('uses the same protocol through the protected relay: $name', async (fixture) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture.completion), {
        headers: { 'X-Muyu-Upstream': 'true' },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const req = structuredClone(fixture.request) as TranslationRequest
    expect(await translate(req, signal(), 'server')).toEqual(fixture.expected)
    expect(fetch.mock.calls[0][0]).toBe('/api/relay')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      baseUrl: req.baseUrl,
      apiKey: req.apiKey,
      timeoutSeconds: req.timeoutSeconds,
      payload: prepareTranslation(req).payload,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('distinguishes server admission refusals from upstream rate limits', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: '服务器忙', retryable: true, rateLimited: true, retryAfter: 5 }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'X-Muyu-Upstream': 'true', 'Retry-After': '7' } }),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(translate(request(), signal(), 'server')).rejects.toMatchObject({
      retryable: true,
      rateLimited: true,
      retryAfter: 5,
    })
    await expect(translate(request(), signal(), 'server')).rejects.toMatchObject({
      retryable: true,
      rateLimited: false,
      retryAfter: 7,
    })
  })

  it('honors Retry-After seconds and exposed HTTP dates within the shared cooldown limit', () => {
    const now = Date.UTC(2026, 8, 15, 12)
    expect(retryAfter('12', now)).toBe(12)
    expect(retryAfter('999999', now)).toBe(3600)
    expect(retryAfter(new Date(now + 15000).toUTCString(), now)).toBe(16)
    expect(retryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0)
    expect(retryAfter('invalid', now)).toBe(0)
  })
})
