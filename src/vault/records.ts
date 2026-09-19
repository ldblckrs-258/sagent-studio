import { decrypt, encrypt } from './crypto'
import { VaultLockedError } from './errors'
import { snapshot } from './keyring'
import type { EncryptedBlob } from './types'

const encoder = new TextEncoder()

export function aadFor(seed: string): Uint8Array {
  return encoder.encode(`${seed}:v1`)
}

function assertUnchanged(before: { key: CryptoKey | null; generation: number }): void {
  const after = snapshot()
  if (after.generation !== before.generation || after.key !== before.key) {
    throw new VaultLockedError('The vault was locked while the record operation was in flight.')
  }
}

export async function encryptRecord(plaintext: string, aadSeed: string): Promise<EncryptedBlob> {
  const before = snapshot()
  if (!before.key) throw new VaultLockedError()
  const blob = await encrypt(before.key, plaintext, aadFor(aadSeed))
  assertUnchanged(before)
  return blob
}

export async function decryptRecord(blob: EncryptedBlob, aadSeed: string): Promise<string> {
  const before = snapshot()
  if (!before.key) throw new VaultLockedError()
  const plaintext = await decrypt(before.key, blob, aadFor(aadSeed))
  assertUnchanged(before)
  return plaintext
}
