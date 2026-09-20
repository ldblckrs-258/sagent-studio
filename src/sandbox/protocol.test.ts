import { describe, expect, it } from 'vitest'
import { BridgeSerializationError, assertSerializable, parseInbound, truncateOutput } from './protocol'

async function realCryptoKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

describe('assertSerializable', () => {
  it('accepts the allow-listed primitives and containers', () => {
    expect(() =>
      assertSerializable({
        text: 'a',
        count: 1,
        ratio: 1.5,
        flag: true,
        nothing: null,
        list: [1, 'two', { three: 3 }],
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).not.toThrow()
  })

  it('rejects non-finite numbers and undefined', () => {
    expect(() => assertSerializable(Number.NaN)).toThrow(BridgeSerializationError)
    expect(() => assertSerializable(Number.POSITIVE_INFINITY)).toThrow(BridgeSerializationError)
    expect(() => assertSerializable(undefined)).toThrow(BridgeSerializationError)
  })

  it('rejects functions and symbols', () => {
    expect(() => assertSerializable(() => 1)).toThrow(BridgeSerializationError)
    expect(() => assertSerializable(Symbol('x'))).toThrow(BridgeSerializationError)
  })

  it('rejects Map, Set, Date, Error, ArrayBuffer, and Blob', () => {
    for (const value of [
      new Map(),
      new Set(),
      new Date(),
      new Error('x'),
      new ArrayBuffer(4),
      new Blob(['x']),
    ]) {
      expect(() => assertSerializable(value)).toThrow(BridgeSerializationError)
    }
  })

  it('rejects a class instance', () => {
    class Thing {
      readonly value = 1
    }
    expect(() => assertSerializable(new Thing())).toThrow(BridgeSerializationError)
  })

  it('rejects a CryptoKey', async () => {
    const key = await realCryptoKey()
    expect(() => assertSerializable(key)).toThrow(BridgeSerializationError)
  })

  it('rejects a workspace directory handle', async () => {
    const { createFakeWorkspace } = await import('../workspace/fake-handle')
    const { handle } = createFakeWorkspace()
    expect(() => assertSerializable(handle)).toThrow(BridgeSerializationError)
  })

  it('rejects a class-based handle-like object', () => {
    class HandleLike {
      readonly kind = 'directory'
    }
    expect(() => assertSerializable(new HandleLike())).toThrow(BridgeSerializationError)
  })

  it('rejects a nested violation', () => {
    expect(() => assertSerializable({ ok: [1, 2, { bad: () => 1 }] })).toThrow(
      BridgeSerializationError,
    )
  })
})

describe('parseInbound', () => {
  it('accepts a valid result message', () => {
    const message = { kind: 'result', runId: 'r1', stdout: 'out', stderr: '', result: null }
    expect(parseInbound(message)).toEqual(message)
  })

  it('accepts a valid fs.call message', () => {
    const message = {
      kind: 'fs.call',
      runId: 'r1',
      requestId: 'q1',
      op: 'write',
      path: 'a.txt',
      data: 'x',
    }
    expect(parseInbound(message)).toEqual(message)
  })

  it('rejects unknown shapes, wrong types, and unknown kinds', () => {
    expect(parseInbound(null)).toBeNull()
    expect(parseInbound('nope')).toBeNull()
    expect(parseInbound({ kind: 'nope' })).toBeNull()
    expect(parseInbound({ kind: 'result', runId: 1 })).toBeNull()
    expect(parseInbound({ kind: 'result', runId: 'r', stdout: 's', stderr: 's', result: 5 })).toBeNull()
    expect(parseInbound({ kind: 'fs.call', runId: 'r', requestId: 'q', op: 'delete', path: 'x' })).toBeNull()
    expect(parseInbound({ kind: 'fs.call', runId: 'r', requestId: 'q', op: 'read', path: 5 })).toBeNull()
  })

  it('drops unknown extra fields', () => {
    const parsed = parseInbound({
      kind: 'result',
      runId: 'r1',
      stdout: '',
      stderr: '',
      result: null,
      extra: true,
    })
    expect(parsed).toEqual({ kind: 'result', runId: 'r1', stdout: '', stderr: '', result: null })
  })

  it('parses a fatal result and a session-fatal message', () => {
    expect(
      parseInbound({ kind: 'result', runId: 'r1', stdout: '', stderr: '', result: null, fatal: true }),
    ).toEqual({ kind: 'result', runId: 'r1', stdout: '', stderr: '', result: null, fatal: true })
    expect(parseInbound({ kind: 'fatal', message: 'died' })).toEqual({
      kind: 'fatal',
      message: 'died',
    })
    expect(parseInbound({ kind: 'fatal' })).toBeNull()
  })
})

describe('truncateOutput', () => {
  it('leaves short output untouched', () => {
    expect(truncateOutput('hello', 10)).toBe('hello')
  })

  it('cuts output past the byte cap', () => {
    expect(truncateOutput('abcdefghij', 4)).toBe('abcd')
  })
})
