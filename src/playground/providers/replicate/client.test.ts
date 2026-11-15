import { describe, expect, it, vi } from 'vitest'
import { createReplicateHttp } from './client'

const TOKEN = 'r8_TestTokenValue0123456789'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json' } })
}

describe('createReplicateHttp', () => {
  it('sends the bearer token against the configured base without cookies', async () => {
    const fetch = vi.fn(async () => json(200, { username: 'me' }))
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    await expect(http.request('GET', '/v1/account')).resolves.toEqual({ username: 'me' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/replicate/v1/account')
    expect(init.credentials).toBe('omit')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('serializes JSON bodies but leaves multipart bodies for the browser to encode', async () => {
    const fetch = vi.fn(async () => json(200, {}))
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    await http.request('POST', '/v1/x', { body: { input: { a: 1 } } })
    const jsonInit = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((jsonInit.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(jsonInit.body).toBe('{"input":{"a":1}}')
    const form = new FormData()
    await http.request('POST', '/v1/files', { body: form })
    const formInit = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1]
    expect(formInit.body).toBe(form)
    expect((formInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it.each([
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [404, 'not_found'],
    [413, 'too_large'],
    [422, 'invalid_input'],
    [429, 'rate_limited'],
    [500, 'http'],
  ])('maps HTTP %i to %s and never echoes the token', async (status, code) => {
    const fetch = vi.fn(async () => json(status, { detail: `bad token ${TOKEN}` }))
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    const error = await http.request('GET', '/v1/account').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code, status })
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('uses the caller fallback when the body has no detail', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }))
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    await expect(
      http.request('GET', '/v1/models/a/b', { fallbacks: { not_found: 'No model a/b.' } }),
    ).rejects.toMatchObject({ message: 'No model a/b.' })
  })

  it('turns a network failure into a sentence naming the proxy path', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    await expect(http.request('GET', '/v1/account')).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('/replicate'),
    })
  })

  it('lets an abort through unchanged so callers can tell Cancel from failure', async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    const http = createReplicateHttp({ apiKey: TOKEN, baseURL: '/replicate', fetch })
    await expect(http.request('GET', '/v1/account')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
