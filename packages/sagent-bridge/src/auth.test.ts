import { describe, expect, it } from 'vitest'
import { checkUpgrade, hasValidToken, isAllowedHost, isAllowedOrigin, redactToken } from './auth.js'

const TOKEN = 'tok_0123456789abcdef'
const ORIGINS = new Set(['http://localhost:5173'])

describe('isAllowedHost', () => {
  it('accepts only loopback names on the bridge port', () => {
    expect(isAllowedHost('127.0.0.1:7717', 7717)).toBe(true)
    expect(isAllowedHost('localhost:7717', 7717)).toBe(true)
    expect(isAllowedHost('[::1]:7717', 7717)).toBe(true)
  })

  it('rejects rebinding hosts that resolve to loopback', () => {
    expect(isAllowedHost('evil.com:7717', 7717)).toBe(false)
    expect(isAllowedHost('127.0.0.1.evil.com:7717', 7717)).toBe(false)
    expect(isAllowedHost('127.0.0.1:8080', 7717)).toBe(false)
    expect(isAllowedHost(undefined, 7717)).toBe(false)
  })
})

describe('isAllowedOrigin', () => {
  it('rejects null, missing and different-port origins', () => {
    expect(isAllowedOrigin('null', ORIGINS)).toBe(false)
    expect(isAllowedOrigin(undefined, ORIGINS)).toBe(false)
    expect(isAllowedOrigin('http://localhost:5174', ORIGINS)).toBe(false)
    expect(isAllowedOrigin('http://localhost:5173', ORIGINS)).toBe(true)
  })
})

describe('hasValidToken', () => {
  it('requires the protocol entry and exactly one matching token entry', () => {
    expect(hasValidToken(['sagent-bridge.v1', `sagent-token.${TOKEN}`], TOKEN)).toBe(true)
    expect(hasValidToken([`sagent-token.${TOKEN}`], TOKEN)).toBe(false)
    expect(hasValidToken(['sagent-bridge.v1'], TOKEN)).toBe(false)
  })

  it('rejects a length mismatch without throwing from timingSafeEqual', () => {
    expect(hasValidToken(['sagent-bridge.v1', `sagent-token.${TOKEN}x`], TOKEN)).toBe(false)
  })

  it('rejects a duplicated token entry so a wrong guess cannot ride next to a right one', () => {
    expect(hasValidToken(['sagent-bridge.v1', `sagent-token.${TOKEN}`, `sagent-token.${TOKEN}`], TOKEN)).toBe(false)
    expect(hasValidToken(['sagent-bridge.v1', 'sagent-token.wrong', `sagent-token.${TOKEN}`], TOKEN)).toBe(false)
  })
})

describe('checkUpgrade', () => {
  const good = {
    host: '127.0.0.1:7717',
    origin: 'http://localhost:5173',
    protocols: `sagent-bridge.v1, sagent-token.${TOKEN}`,
  }

  it('passes when host, origin and token are all valid', () => {
    expect(checkUpgrade(good, 7717, ORIGINS, TOKEN)).toEqual({ ok: true })
  })

  it('checks host before origin and origin before token', () => {
    expect(checkUpgrade({ ...good, host: 'evil.com:7717', origin: 'https://evil.com' }, 7717, ORIGINS, TOKEN)).toMatchObject(
      { ok: false, status: 403, reason: 'host not allowed' },
    )
    expect(checkUpgrade({ ...good, origin: 'https://evil.com', protocols: 'x' }, 7717, ORIGINS, TOKEN)).toMatchObject({
      ok: false,
      status: 403,
      reason: 'origin not allowed',
    })
    expect(checkUpgrade({ ...good, protocols: 'sagent-bridge.v1' }, 7717, ORIGINS, TOKEN)).toMatchObject({
      ok: false,
      status: 401,
    })
  })
})

it('redactToken removes every occurrence', () => {
  expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [redacted] b [redacted]')
})
