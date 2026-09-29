import { describe, expect, it } from 'vitest'
import { encodeInput, isBridgeMessage, isClientMessage, isSessionId } from './protocol.js'

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('isClientMessage', () => {
  it('accepts a well-formed create request', () => {
    expect(
      isClientMessage({
        type: 'create',
        id: '1',
        kind: 'exec',
        command: 'git status',
        shell: 'model',
        owner: { source: 'model', threadId: 't1' },
      }),
    ).toBe(true)
  })

  it('rejects a message with no type, because the router could not dispatch it', () => {
    expect(isClientMessage({ id: '1', command: 'ls' })).toBe(false)
  })

  it('rejects a wrong field type instead of letting it reach a spawn call', () => {
    expect(isClientMessage({ type: 'classify', id: '1', command: 42 })).toBe(false)
    expect(isClientMessage({ type: 'resize', id: '1', session: SESSION, cols: '80', rows: 24 })).toBe(false)
  })

  it('rejects an unknown or prototype-inherited type', () => {
    expect(isClientMessage({ type: 'spawn', id: '1' })).toBe(false)
    expect(isClientMessage({ type: 'toString', id: '1' })).toBe(false)
  })

  it('rejects a non-UUID session id so ids cannot be guessed or path-like', () => {
    expect(isClientMessage({ type: 'kill', id: '1', session: '../1' })).toBe(false)
    expect(isClientMessage({ type: 'kill', id: '1', session: SESSION })).toBe(true)
  })

  it('rejects unknown keys in classifyInput', () => {
    expect(isClientMessage({ type: 'classifyInput', id: '1', session: SESSION, keys: ['f1'], submit: true })).toBe(false)
    expect(isClientMessage({ type: 'classifyInput', id: '1', session: SESSION, keys: ['up'], submit: true })).toBe(true)
  })

  it('requires an owner filter for killOwned so one call cannot kill every session', () => {
    expect(isClientMessage({ type: 'killOwned', id: '1' })).toBe(false)
    expect(isClientMessage({ type: 'killOwned', id: '1', runId: 'r1' })).toBe(true)
  })

  it('rejects a probe nonce that could escape the probe directory', () => {
    expect(isClientMessage({ type: 'verifyRoot', id: '1', nonce: '../../etc/passwd' })).toBe(false)
    expect(isClientMessage({ type: 'verifyRoot', id: '1', nonce: 'abcDEF123_-xyz' })).toBe(true)
  })
})

describe('isBridgeMessage', () => {
  it('accepts hello and rejects an unknown capability', () => {
    const hello = {
      type: 'hello',
      protocol: 1,
      bridgeVersion: '0.1.0',
      platform: 'darwin',
      rootName: 'work',
      rootFingerprint: 'ab',
      capabilities: ['pty', 'exec'],
    }
    expect(isBridgeMessage(hello)).toBe(true)
    expect(isBridgeMessage({ ...hello, capabilities: ['root'] })).toBe(false)
  })

  it('rejects an error with an unknown code', () => {
    expect(isBridgeMessage({ type: 'error', code: 'nope', message: 'x' })).toBe(false)
    expect(isBridgeMessage({ type: 'error', code: 'timeout', message: 'x' })).toBe(true)
  })
})

describe('encodeInput', () => {
  it('appends key sequences and a carriage return on submit', () => {
    expect(encodeInput('y', undefined, true)).toBe('y\r')
    expect(encodeInput(undefined, ['up', 'enter'], false)).toBe('\x1b[A\r')
  })

  it('isSessionId only accepts UUIDs', () => {
    expect(isSessionId(SESSION)).toBe(true)
    expect(isSessionId('abc')).toBe(false)
  })
})
