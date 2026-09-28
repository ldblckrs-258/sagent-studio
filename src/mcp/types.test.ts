import { describe, expect, it } from 'vitest'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  McpConfigError,
  assertUniqueServers,
  newMcpServerId,
  serverSlug,
  validateMcpServerConfig,
} from './types'

function raw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mcp_aaaaaaaaaaaaaaaa',
    name: 'Linear',
    url: 'https://mcp.example.com/mcp',
    transport: 'auto',
    auth: { kind: 'none' },
    enabled: true,
    disabledTools: [],
    timeoutMs: 60_000,
    ...patch,
  }
}

describe('validateMcpServerConfig', () => {
  it('fills defaults for optional fields so older or minimal records stay loadable', () => {
    const config = validateMcpServerConfig(
      raw({ transport: undefined, auth: undefined, disabledTools: undefined, timeoutMs: undefined }),
    )
    expect(config.transport).toBe('auto')
    expect(config.auth).toEqual({ kind: 'none' })
    expect(config.disabledTools).toEqual([])
    expect(config.timeoutMs).toBe(MCP_DEFAULT_TIMEOUT_MS)
  })

  it('mirrors the production CSP: https anywhere, http only on localhost', () => {
    expect(validateMcpServerConfig(raw({ url: 'http://localhost:3000/mcp' })).url).toBe(
      'http://localhost:3000/mcp',
    )
    expect(validateMcpServerConfig(raw({ url: 'http://127.0.0.1:8080/mcp' })).url).toBe(
      'http://127.0.0.1:8080/mcp',
    )
    expect(() => validateMcpServerConfig(raw({ url: 'http://mcp.example.com/mcp' }))).toThrow(
      McpConfigError,
    )
    expect(() => validateMcpServerConfig(raw({ url: 'ws://localhost/mcp' }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ url: 'mcp.example.com' }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ proxyUrl: 'http://proxy.example.com/' }))).toThrow(
      McpConfigError,
    )
  })

  it('requires a proxy URL that the server URL can be appended to', () => {
    expect(() => validateMcpServerConfig(raw({ proxyUrl: 'https://proxy.example.com' }))).toThrow(/must end with/)
    expect(validateMcpServerConfig(raw({ proxyUrl: 'https://proxy.example.com/' })).proxyUrl).toBe(
      'https://proxy.example.com/',
    )
    expect(validateMcpServerConfig(raw({ proxyUrl: 'https://proxy.example.com/?url=' })).proxyUrl).toBe(
      'https://proxy.example.com/?url=',
    )
  })

  it('drops an empty proxy URL instead of storing a blank rewrite target', () => {
    expect(validateMcpServerConfig(raw({ proxyUrl: '  ' }))).not.toHaveProperty('proxyUrl')
  })

  it('rejects headers the transport owns, so a user cannot break session handling', () => {
    expect(() =>
      validateMcpServerConfig(raw({ auth: { kind: 'headers', headers: { 'Mcp-Session-Id': 'x' } } })),
    ).toThrow(/set by the transport/)
    expect(() =>
      validateMcpServerConfig(
        raw({ auth: { kind: 'headers', headers: { 'mcp-protocol-version': 'x' } } }),
      ),
    ).toThrow(/set by the transport/)
  })

  it('rejects header injection through names or multi-line values', () => {
    expect(() =>
      validateMcpServerConfig(raw({ auth: { kind: 'headers', headers: { 'Bad Name': 'x' } } })),
    ).toThrow(McpConfigError)
    expect(() =>
      validateMcpServerConfig(
        raw({ auth: { kind: 'headers', headers: { Authorization: 'a\r\nX-Evil: 1' } } }),
      ),
    ).toThrow(McpConfigError)
    const polluted = JSON.parse('{"kind":"headers","headers":{"__proto__":"x"}}')
    expect(() => validateMcpServerConfig(raw({ auth: polluted }))).toThrow(McpConfigError)
  })

  it('refuses a client secret without a client ID, which no token endpoint accepts', () => {
    expect(() =>
      validateMcpServerConfig(raw({ auth: { kind: 'oauth', clientSecret: 's' } })),
    ).toThrow(/needs a client ID/)
    expect(
      validateMcpServerConfig(raw({ auth: { kind: 'oauth', clientId: ' c ', scopes: '' } })).auth,
    ).toEqual({ kind: 'oauth', clientId: 'c' })
  })

  it('rejects names that produce no tool prefix and out-of-range timeouts', () => {
    expect(() => validateMcpServerConfig(raw({ name: '---' }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ name: 'x'.repeat(41) }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ timeoutMs: 999 }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ timeoutMs: 300_001 }))).toThrow(McpConfigError)
    expect(() => validateMcpServerConfig(raw({ timeoutMs: 1.5 }))).toThrow(McpConfigError)
  })

  it('deduplicates disabled tool names', () => {
    expect(validateMcpServerConfig(raw({ disabledTools: ['a', 'a', 'b'] })).disabledTools).toEqual([
      'a',
      'b',
    ])
  })
})

describe('serverSlug', () => {
  it('produces a tool-name-safe prefix of at most 16 characters', () => {
    expect(serverSlug('My GitHub Server!')).toBe('my_github_server')
    expect(serverSlug('Tiếng Việt')).toBe('ti_ng_vi_t')
    expect(serverSlug('a'.repeat(15) + ' b')).toBe('a'.repeat(15))
    expect(serverSlug('x'.repeat(40))).toHaveLength(16)
  })
})

describe('assertUniqueServers', () => {
  it('refuses two servers whose names share a tool prefix, because their tool names would collide', () => {
    const a = validateMcpServerConfig(raw({ id: 'mcp_a', name: 'My Server' }))
    const b = validateMcpServerConfig(raw({ id: 'mcp_b', name: 'my-server' }))
    expect(() => assertUniqueServers([a, b])).toThrow(/collides/)
    expect(() => assertUniqueServers([a, { ...a }])).not.toThrow()
  })

  it('caps the number of servers', () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      validateMcpServerConfig(raw({ id: `mcp_${index}`, name: `s${index}` })),
    )
    expect(() => assertUniqueServers(many)).toThrow(/At most 20/)
  })
})

describe('newMcpServerId', () => {
  it('creates ids the validator accepts', () => {
    const id = newMcpServerId()
    expect(validateMcpServerConfig(raw({ id })).id).toBe(id)
    expect(newMcpServerId()).not.toBe(id)
  })
})
