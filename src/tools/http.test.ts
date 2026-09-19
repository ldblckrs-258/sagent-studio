import { describe, expect, it } from 'vitest'
import { executeHttpTool, MAX_RESPONSE_BYTES } from './http'
import { HttpToolError } from './types'
import type { HttpRequestTemplate } from './types'

function responseFetch(
  body: string,
  options: { status?: number; contentType?: string; onUrl?: (url: string) => void } = {},
): typeof fetch {
  return (async (url: string | URL | Request) => {
    options.onUrl?.(String(url))
    return new Response(body, {
      status: options.status ?? 200,
      headers: { 'content-type': options.contentType ?? 'application/json' },
    })
  }) as typeof fetch
}

function request(overrides: Partial<HttpRequestTemplate> = {}): HttpRequestTemplate {
  return {
    method: 'GET',
    url: 'https://api.example.com/items',
    allowedOrigins: ['https://api.example.com'],
    ...overrides,
  }
}

describe('executeHttpTool', () => {
  it('substitutes input into the path and query', async () => {
    let seen = ''
    const fetchImpl = responseFetch('{"ok":true}', { onUrl: (url) => (seen = url) })

    const result = await executeHttpTool(
      request({ url: 'https://api.example.com/items/{{input.id}}?q={{input.q}}' }),
      { id: '42', q: 'a b' },
      fetchImpl,
    )

    expect(seen).toBe('https://api.example.com/items/42?q=a%20b')
    expect(result).toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  it('rejects an origin that is not on the allow-list', async () => {
    await expect(
      executeHttpTool(
        request({ allowedOrigins: ['https://other.example.com'] }),
        {},
        responseFetch('{}'),
      ),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects a templated authority', async () => {
    await expect(
      executeHttpTool(
        request({ url: 'https://{{input.host}}/x' }),
        { host: 'api.example.com' },
        responseFetch('{}'),
      ),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects a templated scheme', async () => {
    await expect(
      executeHttpTool(
        request({ url: '{{input.scheme}}://api.example.com/x' }),
        { scheme: 'https' },
        responseFetch('{}'),
      ),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects a relative URL', async () => {
    await expect(
      executeHttpTool(request({ url: '/items' }), {}, responseFetch('{}')),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects a templated header name', async () => {
    await expect(
      executeHttpTool(
        request({ headers: { '{{input.h}}': 'value' } }),
        { h: 'Authorization' },
        responseFetch('{}'),
      ),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('substitutes input into header values and the body', async () => {
    let init: RequestInit | undefined
    const fetchImpl = (async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await executeHttpTool(
      request({
        method: 'POST',
        headers: { 'x-token': '{{input.token}}' },
        body: '{"name":"{{input.name}}"}',
      }),
      { token: 'abc', name: 'bob' },
      fetchImpl,
    )

    expect((init?.headers as Record<string, string>)['x-token']).toBe('abc')
    expect(init?.body).toBe('{"name":"bob"}')
  })

  it('maps a non-2xx response to an error', async () => {
    await expect(
      executeHttpTool(request(), {}, responseFetch('nope', { status: 500 })),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('caps the response body', async () => {
    const huge = 'a'.repeat(MAX_RESPONSE_BYTES + 1)
    await expect(
      executeHttpTool(request(), {}, responseFetch(huge)),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('maps a timeout to an error', async () => {
    const timeoutFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'))
        })
      })) as typeof fetch

    await expect(
      executeHttpTool(request({ timeoutMs: 5 }), {}, timeoutFetch),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects a missing input path', async () => {
    await expect(
      executeHttpTool(request({ url: 'https://api.example.com/{{input.missing}}' }), {}, responseFetch('{}')),
    ).rejects.toBeInstanceOf(HttpToolError)
  })

  it('rejects an unsupported method', async () => {
    await expect(
      executeHttpTool(request({ method: 'TRACE' }), {}, responseFetch('{}')),
    ).rejects.toBeInstanceOf(HttpToolError)
  })
})
