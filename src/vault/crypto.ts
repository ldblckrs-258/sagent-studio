import {
  CorruptVaultError,
  InsecureContextError,
  UnsupportedKdfError,
  WrongPasswordError,
} from './errors'
import type { Bytes, EncryptedBlob, KdfParams } from './types'

export const DEFAULT_ITERATIONS = 600_000
export const SALT_BYTES = 16
export const IV_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const AAD_SETTINGS: Bytes = encoder.encode('settings:v1')
export const AAD_CANARY: Bytes = encoder.encode('canary:v1')
export const CANARY_PLAINTEXT = 'vault-canary-v1'

export function assertSubtle(): SubtleCrypto {
  const impl = globalThis.crypto?.subtle
  if (!impl) throw new InsecureContextError()
  return impl
}

function bufferOf(value: ArrayBufferView): Bytes {
  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
  )
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Bytes {
  if (ArrayBuffer.isView(value)) return bufferOf(value)
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
): Promise<Bytes> {
  const impl = assertSubtle()
  if (!isWellFormed(blob)) {
    throw new CorruptVaultError('Encrypted blob is malformed.')
  }
  try {
    const plaintext = await impl.decrypt(
      { name: 'AES-GCM', iv: toBytes(blob.iv), additionalData: toBytes(aad) },
      key,
      toBytes(blob.ciphertext),
    )
    return toBytes(plaintext)
  } catch (cause) {
    throw new CorruptVaultError(
      'The ciphertext failed authentication (tampered data, mismatched AAD, or wrong key).',
      { cause },
    )
  }
}

export async function decrypt(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: Uint8Array,
): Promise<string> {
  return decoder.decode(await decryptBytes(key, blob, aad))
}

export async function decryptCanary(key: CryptoKey, canary: EncryptedBlob): Promise<void> {
  let value: string
  try {
    value = await decrypt(key, canary, AAD_CANARY)
  } catch (cause) {
    throw new WrongPasswordError(undefined, { cause })
  }
  if (value !== CANARY_PLAINTEXT) {
    throw new CorruptVaultError('Canary decrypted but did not match its expected value.')
  }
}
