import http from 'node:http'
import { createHash } from 'node:crypto'

let calls = [],
  preflights = [],
  failFrom = 0,
  delayMs = 30,
  malformedAt = 0,
  truncateFrom = 0,
  badMemory = false,
  cors = false,
  failureStatus = 401,
  retryAfterSeconds = 0
const translations = [
  '欢迎回来。今天，我们来聊聊现金流。',
  '重要的不只是你赚了多少钱。',
  '还要看你留下了多少，以及钱去了哪里。',
  '试着把自己的财务当作一家小公司。',
  '收入只是其中的一部分。',
  '另一部分是你每个月的支出。',
  '正向现金流让你有喘息的空间。',
  '而这份空间，给了你更多选择。',
  '从小处开始，记录一周的开销。',
  '寻找规律，不必追求完美。',
  '财商是一项可以培养的技能。',
  '每一小步，都有意义。',
]
const handler = async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const allowCORS = cors || req.headers.host?.endsWith(':19093')
  if (allowCORS && req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    preflights.push({ at: Date.now(), origin: req.headers.origin, host: req.headers.host })
    res.writeHead(allowCORS ? 204 : 403).end()
    return
  }
  if (req.url === '/health') {
    res.end('{"ok":true}')
    return
  }
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 3e6) {
      res.writeHead(413).end('{}')
      return
    }
  }
  if (req.url === '/control') {
    if (req.method === 'POST') {
      const value = JSON.parse(raw || '{}')
      if (value.reset) {
        calls = []
        preflights = []
        cors = false
        failureStatus = 401
        retryAfterSeconds = 0
        truncateFrom = 0
        badMemory = false
      }
      if (value.failFrom !== undefined) failFrom = value.failFrom
      if (value.delayMs !== undefined) delayMs = value.delayMs
      if (value.malformedAt !== undefined) malformedAt = value.malformedAt
      if (value.truncateFrom !== undefined) truncateFrom = value.truncateFrom
      if (value.badMemory !== undefined) badMemory = value.badMemory
      if (value.cors !== undefined) cors = value.cors
      if (value.failureStatus !== undefined) failureStatus = value.failureStatus
      if (value.retryAfterSeconds !== undefined) retryAfterSeconds = value.retryAfterSeconds
    }
    res.end(JSON.stringify({ calls, preflights, failFrom, delayMs, malformedAt, cors }))
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end('{}')
    return
  }
  const request = JSON.parse(raw),
    data = JSON.parse(request.messages[1].content)
  calls.push({
    at: Date.now(),
    data,
    model: request.model,
    origin: req.headers.origin ?? '',
    transport: req.headers.origin ? 'direct' : 'server',
    cookie: req.headers.cookie ?? '',
    referer: req.headers.referer ?? '',
    systemPromptHash: createHash('sha256').update(request.messages[0].content).digest('hex'),
    credentialFingerprint: createHash('sha256')
      .update(req.headers.authorization ?? '')
      .digest('hex'),
    maxTokens: request.max_tokens ?? request.max_completion_tokens,
  })
  const sequence = calls.length
  const timer = setTimeout(() => {
    if (failFrom && sequence >= failFrom) {
      if (retryAfterSeconds) res.setHeader('Retry-After', String(retryAfterSeconds))
      res.writeHead(failureStatus).end('{"error":"mock failure body must not be shown"}')
      return
    }
    const firstId = data.cues_to_translate[0].id
    const currentSource = data.cues_to_translate.map((cue) => cue.text).join(' ').toLowerCase()
    const currentTerms = [
      { source: 'small business', target: '小公司', note: '课程用语' },
      { source: 'positive cash flow', target: '正向现金流', note: '课程用语' },
      { source: 'financial literacy', target: '财商', note: '课程用语' },
    ].filter((term) => currentSource.includes(term.source))
    const result = {
      translations: data.cues_to_translate.map((cue) => ({
        id: cue.id,
        text: translations[cue.id - 1] ?? `译文 ${cue.id}`,
      })),
      glossary: [
        { source: 'cash flow', target: '现金流' },
        ...currentTerms,
      ],
      style_notes: `保持教学语气，使用第二人称。当前片段 ${firstId}。`,
    }
    if (sequence === malformedAt) result.translations[0].id = 999
    if (badMemory) {
      result.glossary = [
        { source: '', target: '无效' },
        { source: '现金流', target: '现金流' },
        ...currentTerms,
      ]
      result.style_notes = { invalid: true }
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(result) },
            finish_reason:
              truncateFrom && firstId >= truncateFrom && data.cues_to_translate.length > 1
                ? 'length'
                : 'stop',
          },
        ],
        usage: { prompt_tokens: 350, completion_tokens: 180, total_tokens: 530 },
      }),
    )
  }, delayMs)
  res.on('close', () => clearTimeout(timer))
}
const servers = [19091, 19093].map((port) => http.createServer(handler).listen(port, '127.0.0.1'))
process.on('SIGTERM', () => servers.forEach((server) => server.close()))
