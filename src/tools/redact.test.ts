import { describe, expect, it } from 'vitest'
import { redactForDisplay, redactSecrets } from './redact'

describe('redactSecrets', () => {
  it('scrubs bearer tokens and api keys', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi')
    expect(redactSecrets('sk-1234567890abcdef')).toBe('[redacted]')
  })
})

describe('redactForDisplay', () => {
  it('replaces values under sensitive keys, case- and separator-insensitively', () => {
    const result = redactForDisplay({
      headers: { Authorization: 'Bearer x.y.z', 'X-Api-Key': 'abc' },
      apiKey: 'secret',
      Password: 'hunter2',
      Cookie: 'session=1',
      safe: 'visible',
    }) as Record<string, unknown>
    const headers = result.headers as Record<string, unknown>
    expect(headers.Authorization).toBe('[redacted]')
    expect(headers['X-Api-Key']).toBe('[redacted]')
    expect(result.apiKey).toBe('[redacted]')
    expect(result.Password).toBe('[redacted]')
    expect(result.Cookie).toBe('[redacted]')
    expect(result.safe).toBe('visible')
  })

  it('recurses into arrays and nested objects', () => {
    const result = redactForDisplay({
      tools: [{ name: 'fetch', request: { headers: { authorization: 'Bearer z' } } }],
    }) as { tools: Array<{ name: string; request: { headers: { authorization: string } } }> }
    expect(result.tools[0].name).toBe('fetch')
    expect(result.tools[0].request.headers.authorization).toBe('[redacted]')
  })

  it('scrubs secret-looking strings even under safe keys', () => {
    const result = redactForDisplay({ body: 'token sk-abcdefgh12345678 here' }) as {
      body: string
    }
    expect(result.body).not.toContain('sk-abcdefgh12345678')
  })

  it('returns a placeholder for functions, class instances, and cycles', () => {
    class Thing {
      x = 1
    }
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic

    expect(redactForDisplay({ fn: () => 1 })).toEqual({ fn: '[unserializable]' })
    expect(redactForDisplay({ thing: new Thing() })).toEqual({ thing: '[unserializable]' })
    expect(redactForDisplay(cyclic)).toEqual({ name: 'loop', self: '[circular]' })
  })

  it('leaves primitives untouched', () => {
    expect(redactForDisplay(42)).toBe(42)
    expect(redactForDisplay(true)).toBe(true)
    expect(redactForDisplay(null)).toBe(null)
  })
})
