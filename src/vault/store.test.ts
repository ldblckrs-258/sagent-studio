import { beforeEach, describe, expect, it } from 'vitest'
import { db, META_ID, VAULT_ID } from './db'
import { hasVault, useVaultStore, vaultInternals } from './store'
import { CorruptVaultError, VaultStorageError, WrongPasswordError } from './errors'
import { decrypt, deriveKey, encrypt, AAD_SETTINGS } from './crypto'
import { SETTINGS_VERSION } from './settings'
import {
  FIXTURE_BLOB,
  FIXTURE_CANARY,
  FIXTURE_KDF_PARAMS,
  FIXTURE_PASSWORD,
  FIXTURE_SETTINGS,
} from './test-fixtures'

async function resetAll() {
  await vaultInternals.reset()
  useVaultStore.setState({ status: 'locked', settings: null, error: null, unlockGeneration: 0 })
}

function seededSecret(): string {
  return 'SEEDED_PLAINTEXT_SECRET_1234567890'
}

describe('vault store', () => {
  beforeEach(resetAll)

  it('reports no vault before setup', async () => {
    expect(await hasVault()).toBe('none')
  })

  it('creates a vault and unlocks on a hard reload with the same password', async () => {
    await useVaultStore.getState().setup('hunter2hunter2')
    expect(await hasVault()).toBe('complete')

    await useVaultStore.getState().lock()
    expect(useVaultStore.getState().status).toBe('locked')
    await useVaultStore.getState().unlock('hunter2hunter2')
    expect(useVaultStore.getState().status).toBe('unlocked')
    expect(useVaultStore.getState().settings?.version).toBe(SETTINGS_VERSION)
  })

  it('rejects a wrong password', async () => {
    await useVaultStore.getState().setup('correct-password')
    await useVaultStore.getState().lock()
    await expect(useVaultStore.getState().unlock('wrong-password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    )
    expect(useVaultStore.getState().status).toBe('locked')
  })

  it('reports corruption distinctly from a wrong password', async () => {
    await useVaultStore.getState().setup('correct-password')
    const record = await db.vault.get(VAULT_ID)
    if (!record) throw new Error('missing record')
    const tampered = new Uint8Array(record.blob.ciphertext)
    tampered[0] ^= 0xff
    await db.vault.put({ ...record, blob: { iv: record.blob.iv, ciphertext: tampered } })
    await useVaultStore.getState().lock()

    await expect(useVaultStore.getState().unlock('correct-password')).rejects.toBeInstanceOf(
      CorruptVaultError,
    )
    expect(useVaultStore.getState().status).toBe('recovering')
  })

  it('detects partial state when only the vault record exists', async () => {
    await db.vault.put({ id: VAULT_ID, blob: FIXTURE_BLOB, updatedAt: Date.now() })
    expect(await hasVault()).toBe('partial')
  })

  it('detects partial state when only the meta record exists', async () => {
    await db.meta.put({
      id: META_ID,
      kdfParams: FIXTURE_KDF_PARAMS,
      canary: FIXTURE_CANARY,
      settingsVersion: SETTINGS_VERSION,
      persistedStorage: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(await hasVault()).toBe('partial')
  })

  it('refuses to overwrite an existing vault', async () => {
    await useVaultStore.getState().setup('first-password')
    useVaultStore.setState({ status: 'locked', settings: null })
    await expect(useVaultStore.getState().setup('second-password')).rejects.toBeInstanceOf(
      VaultStorageError,
    )
  })

  it('keeps both fields when two updates race', async () => {
    await useVaultStore.getState().setup('race-password')
    const store = useVaultStore.getState()
    await Promise.all([
      store.update({ idleLockMinutes: 5 }),
      store.update({ egressNoticeDismissed: true }),
    ])
    const settings = useVaultStore.getState().settings
    expect(settings?.idleLockMinutes).toBe(5)
    expect(settings?.egressNoticeDismissed).toBe(true)

    await useVaultStore.getState().lock()
    await useVaultStore.getState().unlock('race-password')
    const reloaded = useVaultStore.getState().settings
    expect(reloaded?.idleLockMinutes).toBe(5)
    expect(reloaded?.egressNoticeDismissed).toBe(true)
  })

  it('rejects an update issued while locked and leaves disk consistent', async () => {
    await useVaultStore.getState().setup('lock-password')
    await useVaultStore.getState().lock()
    await expect(
      useVaultStore.getState().update({ idleLockMinutes: 1 }),
    ).rejects.toThrow()
    await useVaultStore.getState().unlock('lock-password')
    expect(useVaultStore.getState().settings?.idleLockMinutes).toBe(15)
  })

  it('bumps unlockGeneration on lock so memoized clients are invalidated', async () => {
    await useVaultStore.getState().setup('gen-password')
    const before = useVaultStore.getState().unlockGeneration
    await useVaultStore.getState().lock()
    expect(useVaultStore.getState().unlockGeneration).toBe(before + 1)
  })

  it('persists a change across lock and unlock', async () => {
    await useVaultStore.getState().setup('persist-password')
    await useVaultStore.getState().update({ typesafe: { apiKey: seededSecret() } })
    await useVaultStore.getState().lock()
    await useVaultStore.getState().unlock('persist-password')
    expect(useVaultStore.getState().settings?.typesafe.apiKey).toBe(seededSecret())
  })

  it('byte-scans records and finds no seeded plaintext', async () => {
    await useVaultStore.getState().setup('scan-password')
    await useVaultStore.getState().update({ typesafe: { apiKey: seededSecret() } })

    const records = [...(await db.vault.toArray()), ...(await db.meta.toArray())]
    const haystack = records
      .flatMap((record) => Object.values(record as unknown as Record<string, unknown>))
      .map((value) => JSON.stringify(value))
      .join('')
    expect(haystack).not.toContain(seededSecret())
    expect(haystack).not.toContain('scan-password')
  })

  it('does not persist the derived key', async () => {
    await useVaultStore.getState().setup('key-password')
    expect(vaultInternals.hasKey()).toBe(true)
    await useVaultStore.getState().lock()
    expect(vaultInternals.hasKey()).toBe(false)
  })

  it('recovers by erasing all records', async () => {
    await useVaultStore.getState().setup('erase-password')
    await useVaultStore.getState().recover()
    expect(await hasVault()).toBe('none')
    expect(useVaultStore.getState().status).toBe('locked')
  })

  it('throws a migration error for an unknown future settings version', async () => {
    const key = await deriveKey(FIXTURE_PASSWORD, FIXTURE_KDF_PARAMS)
    const future = JSON.stringify({ ...FIXTURE_SETTINGS, version: SETTINGS_VERSION + 1 })
    const blob = await encrypt(key, future, AAD_SETTINGS)
    const canary = await encrypt(key, 'vault-canary-v1', new TextEncoder().encode('canary:v1'))
    await db.vault.put({ id: VAULT_ID, blob, updatedAt: Date.now() })
    await db.meta.put({
      id: META_ID,
      kdfParams: FIXTURE_KDF_PARAMS,
      canary,
      settingsVersion: SETTINGS_VERSION + 1,
      persistedStorage: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(useVaultStore.getState().unlock(FIXTURE_PASSWORD)).rejects.toThrow(/newer/)
  })

  it('unlocks the checked-in fixture blob at the recorded version', async () => {
    await db.vault.put({ id: VAULT_ID, blob: FIXTURE_BLOB, updatedAt: Date.now() })
    await db.meta.put({
      id: META_ID,
      kdfParams: FIXTURE_KDF_PARAMS,
      canary: FIXTURE_CANARY,
      settingsVersion: 1,
      persistedStorage: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await useVaultStore.getState().unlock(FIXTURE_PASSWORD)
    expect(useVaultStore.getState().settings).toEqual(FIXTURE_SETTINGS)
  })

  it('creates only one vault when setup is called twice concurrently', async () => {
    const [a, b] = await Promise.allSettled([
      useVaultStore.getState().setup('concurrent-password'),
      useVaultStore.getState().setup('concurrent-password'),
    ])
    const failures = [a, b].filter((r) => r.status === 'rejected')
    expect(failures.length).toBeLessThanOrEqual(1)
    const metas = await db.meta.toArray()
    expect(metas).toHaveLength(1)
    await useVaultStore.getState().unlock('concurrent-password')
    expect(useVaultStore.getState().settings?.version).toBe(SETTINGS_VERSION)
  })

  it('decrypts the settings blob with its AAD and not the canary AAD', async () => {
    await useVaultStore.getState().setup('aad-password')
    const record = await db.vault.get(VAULT_ID)
    const meta = await db.meta.get(META_ID)
    if (!record || !meta) throw new Error('missing records')
    const key = await deriveKey('aad-password', meta.kdfParams)
    const plaintext = await decrypt(key, record.blob, AAD_SETTINGS)
    expect(JSON.parse(plaintext).version).toBe(SETTINGS_VERSION)
  })
})
