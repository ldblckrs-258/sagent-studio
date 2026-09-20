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
  useVaultStore.setState({
    status: 'locked',
    presence: null,
    settings: null,
    persistedStorage: null,
    error: null,
    unlockGeneration: 0,
  })
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

  it('byte-scans records and finds no seeded plaintext in any byte field', async () => {
    await useVaultStore.getState().setup('scan-password')
    await useVaultStore.getState().update({ typesafe: { apiKey: seededSecret() } })
    await useVaultStore
      .getState()
      .update({ approvals: { tools: { write_file: 'allow', run_python: 'deny' } } })

    const chunks: Uint8Array[] = []
    const collect = (value: unknown): void => {
      if (value instanceof Uint8Array) {
        chunks.push(value)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) collect(item)
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value as Record<string, unknown>)) collect(nested)
      }
    }

    const records = [...(await db.vault.toArray()), ...(await db.meta.toArray())]
    for (const record of records) collect(record)

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const haystack = new TextDecoder('utf-8', { fatal: false }).decode(merged)
    expect(chunks.length).toBeGreaterThan(0)
    expect(haystack).not.toContain(seededSecret())
    expect(haystack).not.toContain('scan-password')
    expect(haystack).not.toContain('write_file')
    expect(haystack).not.toContain('run_python')
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

  it('does not let an update land after lock, and clears resident settings', async () => {
    await useVaultStore.getState().setup('late-write-password')
    const store = useVaultStore.getState()
    const results = await Promise.allSettled([
      store.lock(),
      useVaultStore.getState().update({ idleLockMinutes: 42 }),
    ])
    void results
    expect(useVaultStore.getState().status).toBe('locked')
    expect(useVaultStore.getState().settings).toBeNull()

    const meta = await db.meta.get(META_ID)
    const record = await db.vault.get(VAULT_ID)
    if (!meta || !record) throw new Error('missing records')
    const key = await deriveKey('late-write-password', meta.kdfParams)
    const plaintext = await decrypt(key, record.blob, AAD_SETTINGS)
    expect(JSON.parse(plaintext).idleLockMinutes).toBe(15)
  })

  it('reports presence after recover so the recovery screen can exit', async () => {
    await useVaultStore.getState().setup('recover-presence')
    await useVaultStore.getState().recover()
    expect(useVaultStore.getState().presence).toBe('none')
    await useVaultStore.getState().refreshPresence()
    expect(useVaultStore.getState().presence).toBe('none')
  })

  it('routes a Dexie open failure to the recovering state with a presence set', async () => {
    const original = db.vault.get.bind(db.vault)
    db.vault.get = (() => Promise.reject(new Error('IndexedDB API missing'))) as unknown as typeof db.vault.get
    try {
      await useVaultStore.getState().refreshPresence()
    } finally {
      db.vault.get = original
    }
    expect(useVaultStore.getState().status).toBe('recovering')
    expect(useVaultStore.getState().presence).not.toBeNull()
  })

  it('records that persistent storage was denied', async () => {
    const original = navigator.storage
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: () => Promise.resolve(false),
        persisted: () => Promise.resolve(false),
      },
    })
    try {
      await useVaultStore.getState().setup('no-persist-password')
    } finally {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: original })
    }
    expect(useVaultStore.getState().persistedStorage).toBe(false)
  })

  it('re-reads live persistence on unlock instead of trusting the stored flag', async () => {
    await useVaultStore.getState().setup('recheck-password')
    await useVaultStore.getState().lock()

    const original = navigator.storage
    let live = false
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: () => Promise.resolve(live),
        persisted: () => Promise.resolve(live),
      },
    })
    try {
      // The recorded flag was true from setup; a revoked grant must win.
      await useVaultStore.getState().unlock('recheck-password')
      expect(useVaultStore.getState().persistedStorage).toBe(false)

      await useVaultStore.getState().lock()
      live = true
      await useVaultStore.getState().unlock('recheck-password')
      expect(useVaultStore.getState().persistedStorage).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: original })
    }
  })

  it('grants persistence from an explicit request and clears the warning state', async () => {
    const original = navigator.storage
    let granted = false
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: () => Promise.resolve(granted),
        persisted: () => Promise.resolve(granted),
      },
    })
    try {
      await useVaultStore.getState().setup('request-password')
      expect(useVaultStore.getState().persistedStorage).toBe(false)

      await expect(useVaultStore.getState().requestPersistentStorage()).resolves.toBe(false)
      expect(useVaultStore.getState().persistedStorage).toBe(false)

      granted = true
      await expect(useVaultStore.getState().requestPersistentStorage()).resolves.toBe(true)
      expect(useVaultStore.getState().persistedStorage).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: original })
    }
  })

  it('treats a missing persistent storage API as unknown, not denied', async () => {
    const original = navigator.storage
    Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined })
    try {
      await useVaultStore.getState().setup('noapi-password')
      expect(useVaultStore.getState().persistedStorage).not.toBe(false)
    } finally {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: original })
    }
  })
})
