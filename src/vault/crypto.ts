import {
  CorruptVaultError,
  InsecureContextError,
  MalformedBlobError,
  UnsupportedKdfError,
  WrongPasswordError,
} from './errors'
import type { Bytes, EncryptedBlob, KdfParams } from './types'

export const DEFAULT_ITERATIONS = 600_000
export const SALT_BYTES = 16
export const IV_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const AAD_SETTINGS = encoder.encode('settings:v1')
export const AAD_CANARY = encoder.encode('canary:v1')
export const CANARY_PLAINTEXT = 'vault-canary-v1'

class AuthenticationError extends Error {
  constructor(cause: unknown) {
    super('AES-GCM authentication failed.', { cause })
    this.name = 'AuthenticationError'
  }
}

export function assertSubtle(): SubtleCrypto {
  const impl = globalThis.crypto?.subtle
  if (!impl) throw new InsecureContextError()
  return impl
}

function bufferOf(value: ArrayBufferView): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Bytes {
  if (ArrayBuffer.isView(value)) return new Uint8Array(bufferOf(value))
  return new Uint8Array(value)
}

export function randomBytes(length: number): Bytes {
  assertSubtle()
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('randomBytes length must be a positive integer.')
  }
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export async function deriveKey(password: string, params: KdfParams): Promise<CryptoKey> {
  const impl = assertSubtle()

  switch (params.algorithm) {
    case 'PBKDF2-SHA256': {
      const base = await impl.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey'],
      )
      return impl.deriveKey(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: params.salt,
          iterations: params.iterations,
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    }
    default:
      throw new UnsupportedKdfError((params as { algorithm: string }).algorithm)
  }
}

export async function encrypt(
  key: CryptoKey,
  plaintext: string | Bytes,
  aad: Uint8Array,
): Promise<EncryptedBlob> {
  const impl = assertSubtle()
  const iv = randomBytes(IV_BYTES)
  const data = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext
  const ciphertext = await impl.encrypt(
    { name: 'AES-GCM', iv, additionalData: toBytes(aad) },
    key,
    data,
  )
  return { iv, ciphertext: toBytes(ciphertext) }
}

function isWellFormed(blob: EncryptedBlob): boolean {
  return (
    blob != null &&
    blob.iv instanceof Uint8Array &&
    blob.iv.byteLength === IV_BYTES &&
    blob.ciphertext instanceof Uint8Array &&
    blob.ciphertext.byteLength > 0
  )
}

export async function decryptBytes(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const impl = assertSubtle()
  if (!isWellFormed(blob)) {
    throw new MalformedBlobError()
  }
  try {
    const plaintext = await impl.decrypt(
      { name: 'AES-GCM', iv: toBytes(blob.iv), additionalData: toBytes(aad) },
      key,
      toBytes(blob.ciphertext),
    )
    return toBytes(plaintext)
  } catch (cause) {
    throw new AuthenticationError(cause)
  }
}

export async function decrypt(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: Uint8Array,
): Promise<string> {
  try {
    return decoder.decode(await decryptBytes(key, blob, aad))
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new CorruptVaultError(
        'The ciphertext failed authentication (tampered data, mismatched AAD, or wrong key).',
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Validates a password against the canary blob. Only an authentication failure
 * is interpreted as a wrong password; insecure-context and malformed-blob errors
 * propagate unchanged so they are not misreported as a credential problem.
 */
export async function decryptCanary(key: CryptoKey, canary: EncryptedBlob): Promise<void> {
  let value: string
  try {
    value = decoder.decode(await decryptBytes(key, canary, AAD_CANARY))
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new WrongPasswordError(undefined, { cause: error })
    }
    throw error
  }
  if (value !== CANARY_PLAINTEXT) {
    throw new CorruptVaultError('Canary decrypted but did not match its expected value.')
  }
}
