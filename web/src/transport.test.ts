import { afterEach, describe, expect, it, vi } from 'vitest'
import { post, serverError, APIError } from './transport'
const error = async () => {
  throw await serverError(await post('relay', {}))
}

afterEach(() => vi.unstubAllGlobals())

describe('server throttling protocol', () => {
  it('preserves retry instructions for local HTTP 429 refusals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'server throttled',
            retryable: true,
            retryAfter: 7,
            rateLimited: true,
          }),
          { status: 429 },
        ),
      ),
    )
    await expect(error()).rejects.toMatchObject({
      message: 'server throttled',
      retryable: true,
      retryAfter: 7,
      rateLimited: true,
    })
  })

  it('keeps upstream failures within the normal retry budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'upstream failed',
            retryable: true,
            retryAfter: 2,
            rateLimited: true,
          }),
          { status: 502 },
        ),
      ),
    )
    await expect(error()).rejects.toMatchObject({
      retryable: true,
      retryAfter: 2,
      rateLimited: false,
    })
  })

  it('does not retry a denied API host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'host denied',
            retryable: false,
          }),
          { status: 403 },
        ),
      ),
    )
    await expect(error()).rejects.toEqual(new APIError('host denied'))
  })
})
