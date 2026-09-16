import { MessageError, message, type Message } from './messages'

export class APIError extends MessageError {
  constructor(
    message: Message,
    public retryable = false,
    public retryAfter = 0,
    public rateLimited = false,
  ) {
    super(message)
  }
}

// fetch does not distinguish a CORS refusal from a connection failure. Only
// this failure, before a readable response, is eligible for server fallback.
export class DirectConnectionError extends APIError {
  constructor() {
    super('浏览器直连因跨域或网络问题失败，将尝试服务器转发')
  }
}

export async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new APIError('请求已中断', false)
    throw new APIError('网络连接中断，已保留完成的进度', true)
  }
  return response
}

export async function serverError(response: Response): Promise<APIError> {
  let data: any
  try {
    data = await response.json()
  } catch {
    return new APIError('服务返回了无效响应，请稍后重试', response.status >= 500)
  }
  return new APIError(
    data && typeof data.error === 'string' ? data.error : message('请求失败（{0}）', { 0: response.status }),
    !!data?.retryable,
    Math.max(0, Math.min(3600, Number(data?.retryAfter) || 0)),
    response.status === 429 && data?.rateLimited === true,
  )
}
