import { afterEach, describe, expect, it } from 'vitest'
import {
  AAD_CANARY,
  AAD_SETTINGS,
  CANARY_PLAINTEXT,
  DEFAULT_ITERATIONS,
  decrypt,
  decryptBytes,
  decryptCanary,
  deriveKey,
  encrypt,
  randomBytes,
} from './crypto'
import type { KdfParams } from './types'
import {
  CorruptVaultError,
  InsecureContextError,
  UnsupportedKdfError,
  WrongPasswordError,
} from './errors'

const FAST: KdfParams = {
  algorithm: 'PBKDF2-SHA256',
  iterations: 1_000,
  salt: new Uint8Array(16).fill(7),
}

describe('randomBytes', () => {
  it('produces distinct values of the requested length', () => {
    const a = randomBytes(16)
    const b = randomBytes(16)
    expect(a).toHaveLength(16)
    expect(b).toHaveLength(16)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('rejects a non-positive length', () => {
    expect(() => randomBytes(0)).toThrow(RangeError)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a UTF-8 string', async () => {
    const key = await deriveKey('correct horse', FAST)
    const blob = await encrypt(key, 'hello — 世界', AAD_SETTINGS)
    expect(blob.iv).toHaveLength(12)
    expect(await decrypt(key, blob, AAD_SETTINGS)).toBe('hello — 世界')
  })

  it('round-trips a large payload byte-identically', async () => {
    const key = await deriveKey('correct horse', FAST)
    const payload = new Uint8Array(256 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const blob = await encrypt(key, payload, AAD_SETTINGS)
    const out = await decryptBytes(key, blob, AAD_SETTINGS)
    expect(out).toEqual(payload)
  })

  it('round-trips empty input', async () => {
    const key = await deriveKey('pw', FAST)
    const blob = await encrypt(key, '', AAD_SETTINGS)
    expect(await decrypt(key, blob, AAD_SETTINGS)).toBe('')
  })

  it('uses a fresh IV per call', async () => {
    const key = await deriveKey('pw', FAST)
    const a = await encrypt(key, 'same', AAD_SETTINGS)
    const b = await encrypt(key, 'same', AAD_SETTINGS)
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv))
  })

  it('fails a wrong password with WrongPasswordError via the canary path', async () => {
    const key = await deriveKey('right', FAST)
    const canary = await encrypt(key, CANARY_PLAINTEXT, AAD_CANARY)
    const wrongKey = await deriveKey('wrong', FAST)
    await expect(decryptCanary(wrongKey, canary)).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('rejects tampered ciphertext as CorruptVaultError', async () => {
    const key = await deriveKey('pw', FAST)
    const blob = await encrypt(key, 'secret', AAD_SETTINGS)
    const tampered = new Uint8Array(blob.ciphertext)
    tampered[0] ^= 0xff
    await expect(
      decrypt(key, { iv: blob.iv, ciphertext: tampered }, AAD_SETTINGS),
    ).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('rejects a tampered IV as CorruptVaultError', async () => {
    const key = await deriveKey('pw', FAST)
    const blob = await encrypt(key, 'secret', AAD_SETTINGS)
    const iv = new Uint8Array(blob.iv)
    iv[0] ^= 0xff
    await expect(decrypt(key, { iv, ciphertext: blob.ciphertext }, AAD_SETTINGS)).rejects.toBeInstanceOf(
      CorruptVaultError,
    )
  })

  it('rejects a malformed blob as MalformedBlobError (a CorruptVaultError)', async () => {
    const key = await deriveKey('pw', FAST)
    const error = await decrypt(
      key,
      { iv: new Uint8Array(4), ciphertext: new Uint8Array(8) },
      AAD_SETTINGS,
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(CorruptVaultError)
    expect((error as Error).name).toBe('MalformedBlobError')
  })

  it('rejects a mismatched AAD as CorruptVaultError', async () => {
    const key = await deriveKey('pw', FAST)
    const blob = await encrypt(key, 'secret', AAD_SETTINGS)
    await expect(decrypt(key, blob, AAD_CANARY)).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('does not return partial plaintext on a wrong password', async () => {
    const key = await deriveKey('right', FAST)
    const blob = await encrypt(key, 'do not leak', AAD_SETTINGS)
    const wrongKey = await deriveKey('wrong', FAST)
    await expect(decrypt(wrongKey, blob, AAD_SETTINGS)).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('rejects an argon2id KdfParams arm as unsupported', async () => {
    await expect(
      deriveKey('pw', {
        algorithm: 'argon2id',
        memoryKiB: 1024,
        iterations: 2,
        salt: new Uint8Array(16),
      }),
    ).rejects.toBeInstanceOf(UnsupportedKdfError)
  })
})

describe('insecure context', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
  })

  function removeSubtle() {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: <T extends ArrayBufferView>(a: T): T => a },
    })
  }

  it('assertSubtle-equivalent: randomBytes throws InsecureContextError', () => {
    removeSubtle()
    expect(() => randomBytes(8)).toThrow(InsecureContextError)
  })

  it('deriveKey throws InsecureContextError', async () => {
    removeSubtle()
    await expect(deriveKey('pw', FAST)).rejects.toBeInstanceOf(InsecureContextError)
  })

  it('encrypt throws InsecureContextError', async () => {
    const key = await deriveKey('pw', FAST)
    removeSubtle()
    await expect(encrypt(key, 'x', AAD_SETTINGS)).rejects.toBeInstanceOf(InsecureContextError)
  })

  it('decrypt throws InsecureContextError, not a raw TypeError', async () => {
    const key = await deriveKey('pw', FAST)
    const blob = await encrypt(key, 'x', AAD_SETTINGS)
    removeSubtle()
    await expect(decrypt(key, blob, AAD_SETTINGS)).rejects.toBeInstanceOf(InsecureContextError)
  })

  it('decryptCanary propagates InsecureContextError instead of a WrongPasswordError', async () => {
    const key = await deriveKey('pw', FAST)
    const canary = await encrypt(key, CANARY_PLAINTEXT, AAD_CANARY)
    removeSubtle()
    await expect(decryptCanary(key, canary)).rejects.toBeInstanceOf(InsecureContextError)
  })

  it('decryptCanary reports a malformed canary as corruption, not a wrong password', async () => {
    const key = await deriveKey('pw', FAST)
    await expect(
      decryptCanary(key, { iv: new Uint8Array(3), ciphertext: new Uint8Array(2) }),
    ).rejects.toBeInstanceOf(CorruptVaultError)
  })
})

describe('PBKDF2 baseline', () => {
  it('records derivation time at the default iteration count', async () => {
    const salt = randomBytes(16)
    const params: KdfParams = { algorithm: 'PBKDF2-SHA256', iterations: DEFAULT_ITERATIONS, salt }
    const start = performance.now()
    await deriveKey('baseline-password', params)
    const elapsed = performance.now() - start
    console.log(
      `[vault] PBKDF2-SHA256 ${DEFAULT_ITERATIONS} iterations: ${elapsed.toFixed(0)}ms (machine-specific)`,
    )
    expect(elapsed).toBeGreaterThan(0)
  })
})
