import { describe, expect, it } from 'vitest'
import { assertRequestTemplates, executeHttpTool, MAX_RESPONSE_BYTES } from './http'
import { ToolSchemaError } from './types'
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
    expect(result).toEqual({
      ok: true,
      code: 'ok',
      value: { status: 200, contentType: 'application/json', body: '{"ok":true}' },
    })
  })

  it('returns an http_error envelope for an origin that is not on the allow-list', async () => {
    await expect(
      executeHttpTool(request({ allowedOrigins: ['https://other.example.com'] }), {}, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an http_error envelope for a templated authority', async () => {
    await expect(
      executeHttpTool(request({ url: 'https://{{input.host}}/x' }), { host: 'api.example.com' }, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an http_error envelope for a templated scheme', async () => {
    await expect(
      executeHttpTool(request({ url: '{{input.scheme}}://api.example.com/x' }), { scheme: 'https' }, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an http_error envelope for a relative URL', async () => {
    await expect(
      executeHttpTool(request({ url: '/items' }), {}, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an http_error envelope for a templated header name', async () => {
    await expect(
      executeHttpTool(request({ headers: { '{{input.h}}': 'value' } }), { h: 'Authorization' }, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('substitutes input into header values and the body', async () => {
    let init: RequestInit | undefined
    const fetchImpl = (async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await executeHttpTool(
      request({
        method: 'POST',
        headers: { 'x-token': '{{input.token}}' },
        body: '{"name":"{{input.name}}"}',
      }),
      { token: 'abc', name: 'bob' },
      fetchImpl,
    )

    expect(result.ok).toBe(true)
    expect((init?.headers as Record<string, string>)['x-token']).toBe('abc')
    expect(init?.body).toBe('{"name":"bob"}')
  })

  it('maps a non-2xx response to an http_error envelope', async () => {
    await expect(
      executeHttpTool(request(), {}, responseFetch('nope', { status: 500 })),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('caps the response body with an http_error envelope', async () => {
    const huge = 'a'.repeat(MAX_RESPONSE_BYTES + 1)
    await expect(
      executeHttpTool(request(), {}, responseFetch(huge)),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('maps a timeout to an http_error envelope', async () => {
    const timeoutFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'))
        })
      })) as typeof fetch

    await expect(
      executeHttpTool(request({ timeoutMs: 5 }), {}, timeoutFetch),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an invalid_input style http_error envelope for a missing input path', async () => {
    await expect(
      executeHttpTool(request({ url: 'https://api.example.com/{{input.missing}}' }), {}, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('returns an http_error envelope for an unsupported method', async () => {
    await expect(
      executeHttpTool(request({ method: 'TRACE' }), {}, responseFetch('{}')),
    ).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })
})

describe('placeholder validation', () => {
  it('rejects a template whose placeholder is not input-scoped', () => {
    expect(() =>
      assertRequestTemplates(request({ url: 'https://api.example.com/posts/{{id}}' }), 'demo'),
    ).toThrow(ToolSchemaError)
    expect(() =>
      assertRequestTemplates(request({ body: '{"id":"{{ args.id }}"}' }), 'demo'),
    ).toThrow(ToolSchemaError)
    expect(() =>
      assertRequestTemplates(
        request({ headers: { 'x-key': '{{secret}}' } }),
        'demo',
      ),
    ).toThrow(ToolSchemaError)
  })

  it('accepts input-scoped placeholders', () => {
    expect(() =>
      assertRequestTemplates(
        request({
          url: 'https://api.example.com/posts/{{input.id}}',
          body: '{"q":"{{ input.query }}"}',
          headers: { 'x-key': '{{input.key}}' },
        }),
        'demo',
      ),
    ).not.toThrow()
  })

  it('reports an unsubstituted url placeholder instead of calling the server', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await executeHttpTool(
      request({ url: 'https://api.example.com/posts/{{id}}' }),
      { id: 1 },
      fetchImpl,
    )

    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('http_error')
    expect(result.message).toContain('{{id}}')
  })
})
