import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from './crypto'
import { CorruptVaultError, VaultLockedError } from './errors'
import * as keyring from './keyring'
import { decryptRecord, encryptRecord } from './records'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function installKey(): Promise<void> {
  keyring.reset()
  keyring.install(await deriveKey('record-password', KDF))
}

describe('vault records', () => {
  beforeEach(async () => {
    await installKey()
  })

  it('round-trips a plaintext record', async () => {
    const blob = await encryptRecord('{"hello":"world"}', 'thread:a')
    await expect(decryptRecord(blob, 'thread:a')).resolves.toBe('{"hello":"world"}')
  })

  it('binds the ciphertext to its aad seed', async () => {
    const blob = await encryptRecord('secret', 'thread:a')
    await expect(decryptRecord(blob, 'thread:b')).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('rejects encrypt and decrypt while the keyring is empty', async () => {
    keyring.reset()
    await expect(encryptRecord('x', 's')).rejects.toBeInstanceOf(VaultLockedError)
    const blob = await (async () => {
      await installKey()
      return encryptRecord('x', 's')
    })()
    keyring.clear()
    await expect(decryptRecord(blob, 's')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('rejects an encrypt whose keyring changes mid-call', async () => {
    const inFlight = encryptRecord('x', 's')
    keyring.clear()
    await expect(inFlight).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('rejects a decrypt whose keyring changes mid-call', async () => {
    const blob = await encryptRecord('x', 's')
    const inFlight = decryptRecord(blob, 's')
    keyring.clear()
    await expect(inFlight).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('rejects a decrypt with a malformed blob', async () => {
    await expect(
      decryptRecord({ iv: new Uint8Array(4), ciphertext: new Uint8Array(0) }, 's'),
    ).rejects.toBeInstanceOf(CorruptVaultError)
  })
})
