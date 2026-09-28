import { describe, expect, it } from 'vitest'
import { createMcpFetch, proxiedUrl } from './fetch'

function recorder() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url instanceof URL ? url.href : url, ...(init ? { init } : {}) })
    return new Response('ok')
  }
  return { calls, fetchImpl }
}

describe('createMcpFetch', () => {
  it('sends requests straight to the target when no proxy is configured', async () => {
    const { calls, fetchImpl } = recorder()
    const mcpFetch = createMcpFetch({ auth: { kind: 'none' } }, fetchImpl)
    await mcpFetch(new URL('https://mcp.example.com/mcp'), { method: 'POST' })
    expect(calls[0]?.url).toBe('https://mcp.example.com/mcp')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('prefixes every request with the proxy URL, including OAuth discovery, so a CORS-less server works', async () => {
    const { calls, fetchImpl } = recorder()
    const mcpFetch = createMcpFetch(
      { proxyUrl: 'https://proxy.example.com/', auth: { kind: 'none' } },
      fetchImpl,
    )
    await mcpFetch('https://mcp.example.com/.well-known/oauth-protected-resource')
    expect(calls[0]?.url).toBe(
      'https://proxy.example.com/https://mcp.example.com/.well-known/oauth-protected-resource',
    )
  })

  it('adds configured headers over any header the SDK set, and keeps the SDK headers', async () => {
    const { calls, fetchImpl } = recorder()
    const mcpFetch = createMcpFetch(
      { auth: { kind: 'headers', headers: { Authorization: 'Bearer secret', 'X-Team': 't1' } } },
      fetchImpl,
    )
    await mcpFetch('https://mcp.example.com/mcp', {
      headers: { accept: 'application/json, text/event-stream', authorization: 'stale' },
    })
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(headers.get('x-team')).toBe('t1')
    expect(headers.get('accept')).toBe('application/json, text/event-stream')
  })

  it('never adds static headers to an OAuth server, whose token the SDK manages', async () => {
    const { calls, fetchImpl } = recorder()
    const mcpFetch = createMcpFetch({ auth: { kind: 'oauth' } }, fetchImpl)
    await mcpFetch('https://mcp.example.com/mcp', { headers: { Authorization: 'Bearer from-sdk' } })
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer from-sdk')
  })
})

describe('proxiedUrl', () => {
  it('leaves the target untouched without a proxy', () => {
    expect(proxiedUrl({}, 'https://a.example.com/x')).toBe('https://a.example.com/x')
  })
})
