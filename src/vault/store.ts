import { create } from 'zustand'
import {
  DEFAULT_ITERATIONS,
  SALT_BYTES,
  AAD_CANARY,
  AAD_SETTINGS,
  CANARY_PLAINTEXT,
  decrypt,
  decryptCanary,
  deriveKey,
  encrypt,
  randomBytes,
} from './crypto'
import { db, META_ID, VAULT_ID } from './db'
import type { MetaRecord, VaultRecord } from './db'
import {
  CorruptVaultError,
  VaultLockedError,
  VaultStorageError,
  WrongPasswordError,
} from './errors'
import { defaultSettings, deepMerge, migrate, SETTINGS_VERSION } from './settings'
import type { DeepPartial, Settings } from './settings'
import type { KdfParams } from './types'
import { vaultWriteQueue } from './write-queue'
import * as keyring from './keyring'
import { invalidate as invalidateClients, setGeneration } from '../ai/client-cache'

export type VaultStatus = 'locked' | 'unlocking' | 'unlocked' | 'recovering'
export type VaultPresence = 'none' | 'complete' | 'partial'

export interface VaultState {
  status: VaultStatus
  presence: VaultPresence | null
  settings: Settings | null
  persistedStorage: boolean | null
  unlockGeneration: number
  error: string | null
  refreshPresence(): Promise<void>
  setup(password: string): Promise<void>
  unlock(password: string): Promise<void>
  lock(): Promise<void>
  update(patch: DeepPartial<Settings>): Promise<void>
  recover(): Promise<void>
  clearError(): void
  /** Requests persistent storage from the browser and records the outcome. */
  requestPersistentStorage(): Promise<boolean>
}

let createInFlight: Promise<unknown> | null = null

function newKdfParams(): KdfParams {
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: DEFAULT_ITERATIONS,
    salt: randomBytes(SALT_BYTES),
  }
}

/**
 * Reads whether this origin is already granted persistent storage. This never
 * prompts, so it is safe to call on every unlock.
 */
async function readPersisted(): Promise<boolean | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      return await navigator.storage.persisted()
    }
  } catch {
    return null
  }
  return null
}

/**
 * Asks the browser to grant persistent storage. Chromium decides silently from
 * engagement heuristics; Firefox shows a prompt, which is why this is only
 * called from a user gesture or shortly after one.
 */
async function askPersisted(): Promise<boolean | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist()
    }
  } catch {
    return null
  }
  return null
}

async function writePersisted(persisted: boolean): Promise<void> {
  const meta = await db.meta.get(META_ID)
  if (meta) await db.meta.put({ ...meta, persistedStorage: persisted, updatedAt: Date.now() })
}

export async function hasVault(): Promise<VaultPresence> {
  const [vault, meta] = await Promise.all([db.vault.get(VAULT_ID), db.meta.get(META_ID)])
  const hasVaultRecord = vault !== undefined
  const hasMetaRecord = meta !== undefined
  if (hasVaultRecord && hasMetaRecord) return 'complete'
  if (hasVaultRecord || hasMetaRecord) return 'partial'
  return 'none'
}

async function createVaultInternal(password: string): Promise<CryptoKey> {
  const persisted = await askPersisted()
  const kdfParams = newKdfParams()
  const derived = await deriveKey(password, kdfParams)
  const canary = await encrypt(derived, CANARY_PLAINTEXT, AAD_CANARY)
  const blob = await encrypt(derived, JSON.stringify(defaultSettings()), AAD_SETTINGS)
  const now = Date.now()

  await db.transaction('rw', db.vault, db.meta, async () => {
    const [existingVault, existingMeta] = await Promise.all([
      db.vault.get(VAULT_ID),
      db.meta.get(META_ID),
    ])
    if (existingVault || existingMeta) {
      throw new VaultStorageError('A vault already exists; refusing to overwrite it.')
    }
    await db.vault.put({ id: VAULT_ID, blob, updatedAt: now })
    await db.meta.put({
      id: META_ID,
      kdfParams,
      canary,
      settingsVersion: SETTINGS_VERSION,
      persistedStorage: persisted,
      createdAt: now,
      updatedAt: now,
    })
  })

  return derived
}

async function createVaultOnce(password: string): Promise<CryptoKey> {
  if (createInFlight) {
    await createInFlight.catch(() => undefined)
    throw new VaultStorageError('A vault was created concurrently.')
  }
  let derivedKey: CryptoKey | null = null
  const promise = (async () => {
    derivedKey = await createVaultInternal(password)
  })()
  createInFlight = promise
  try {
    await promise
  } finally {
    createInFlight = null
  }
  if (!derivedKey) throw new VaultStorageError('Vault creation did not produce a key.')
  return derivedKey
}

async function unlockInternal(
  password: string,
): Promise<{ settings: Settings; persisted: boolean | null; key: CryptoKey }> {
  const meta = await db.meta.get(META_ID)
  const vault = await db.vault.get(VAULT_ID)
  if (!meta || !vault) {
    throw new VaultStorageError('The vault is incomplete and cannot be unlocked.')
  }
  const derived = await deriveKey(password, meta.kdfParams)
  await decryptCanary(derived, meta.canary)
  const raw = await decrypt(derived, vault.blob, AAD_SETTINGS)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new CorruptVaultError('Decrypted settings were not valid JSON.', { cause })
  }
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? Number((parsed as { version: unknown }).version)
      : meta.settingsVersion
  const settings = migrate(version, parsed)
  // The stored flag only records what was true at creation time. The live
  // reading is authoritative: a user may have granted persistence since, or had
  // it revoked. Falls back to the recorded value when the API is unavailable.
  const live = await readPersisted()
  const persisted = live ?? meta.persistedStorage
  if (live !== null && live !== meta.persistedStorage) {
    await writePersisted(live)
  }
  return { settings, persisted, key: derived }
}

async function persistSettings(currentKey: CryptoKey, next: Settings): Promise<void> {
  const blob = await encrypt(currentKey, JSON.stringify(next), AAD_SETTINGS)
  try {
    await db.vault.put({ id: VAULT_ID, blob, updatedAt: Date.now() })
    const meta = await db.meta.get(META_ID)
    if (meta) {
      await db.meta.put({ ...meta, updatedAt: Date.now() })
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'QuotaExceededError') {
      throw new VaultStorageError('Browser storage quota exceeded.', { cause })
    }
    throw cause
  }
}

function describeError(error: unknown): string {
  if (
    error instanceof WrongPasswordError ||
    error instanceof CorruptVaultError ||
    error instanceof VaultStorageError ||
    error instanceof VaultLockedError
  ) {
    return error.message
  }
  if (error instanceof Error) return error.message
  return 'An unknown vault error occurred.'
}

export const useVaultStore = create<VaultState>((set, get) => ({
  status: 'locked',
  presence: null,
  settings: null,
  persistedStorage: null,
  unlockGeneration: 0,
  error: null,

  async refreshPresence() {
    try {
      const presence = await hasVault()
      set({ presence })
    } catch (cause) {
      // A Dexie open failure must reach the recovery screen, not leave the app
      // on an indefinite loading state.
      set({ presence: 'partial', status: 'recovering', error: describeError(cause) })
    }
  },

  async setup(password) {
    set({ status: 'unlocking', error: null })
    try {
      const derived = await createVaultOnce(password)
      keyring.install(derived)
      const generation = keyring.getGeneration()
      setGeneration(generation)
      set({
        status: 'unlocked',
        presence: 'complete',
        settings: defaultSettings(),
        persistedStorage: (await readPersisted()) ?? true,
        unlockGeneration: generation,
        error: null,
      })
    } catch (error) {
      keyring.clear()
      set({
        status: 'locked',
        settings: null,
        unlockGeneration: keyring.getGeneration(),
        error: describeError(error),
      })
      throw error
    }
  },

  async unlock(password) {
    set({ status: 'unlocking', error: null })
    try {
      const { settings, persisted, key: derived } = await unlockInternal(password)
      keyring.install(derived)
      const generation = keyring.getGeneration()
      setGeneration(generation)
      set({
        status: 'unlocked',
        presence: 'complete',
        settings,
        persistedStorage: persisted,
        unlockGeneration: generation,
        error: null,
      })
      // Retry the grant on every successful unlock. Unlock always follows a user
      // gesture (the password submit), which is the context where a browser may
      // still be willing to grant persistence.
      if (!persisted) void get().requestPersistentStorage()
    } catch (error) {
      keyring.clear()
      const status: VaultStatus = error instanceof CorruptVaultError ? 'recovering' : 'locked'
      set({
        status,
        settings: null,
        unlockGeneration: keyring.getGeneration(),
        error: describeError(error),
      })
      throw error
    }
  },

  async lock() {
    // Clear the key synchronously so any update enqueued after this point fails
    // its identity check instead of landing after the store reports `locked`.
    keyring.clear()
    invalidateClients()
    await vaultWriteQueue.drain()
    set({
      status: 'locked',
      settings: null,
      error: null,
      unlockGeneration: keyring.getGeneration(),
    })
  },

  async update(patch) {
    const currentKey = keyring.getKey()
    if (!currentKey) throw new VaultLockedError()
    await vaultWriteQueue.enqueue(async () => {
      if (keyring.getKey() !== currentKey) throw new VaultLockedError()
      const latest = get().settings
      if (!latest) throw new VaultLockedError()
      const next = deepMerge(latest, patch)
      await persistSettings(currentKey, next)
      if (keyring.getKey() === currentKey) set({ settings: next })
    })
  },

  async recover() {
    keyring.clear()
    await vaultWriteQueue.drain()
    await db.transaction(
      'rw',
      [db.vault, db.meta, db.threads, db.skills, db.tools, db.fs, db.documents, db.chunks],
      async () => {
        await db.vault.clear()
        await db.meta.clear()
        await db.threads.clear()
        await db.skills.clear()
        await db.tools.clear()
        await db.fs.clear()
        await db.documents.clear()
        await db.chunks.clear()
      },
    )
    invalidateClients()
    set({
      status: 'locked',
      presence: 'none',
      settings: null,
      persistedStorage: null,
      error: null,
      unlockGeneration: keyring.getGeneration(),
    })
  },

  clearError() {
    set({ error: null })
  },

  async requestPersistentStorage() {
    const granted = await askPersisted()
    if (granted === null) return get().persistedStorage === true
    await writePersisted(granted)
    set({ persistedStorage: granted })
    return granted
  },
}))

export const vaultInternals = {
  getKey: () => keyring.getKey(),
  reset: async () => {
    await db.vault.clear()
    await db.meta.clear()
    await db.threads.clear()
    await db.skills.clear()
    await db.tools.clear()
    await db.fs.clear()
    await db.documents.clear()
    await db.chunks.clear()
    keyring.reset()
    createInFlight = null
    vaultWriteQueue.reset()
  },
  hasKey: () => keyring.getKey() !== null,
}

export type { VaultRecord, MetaRecord }
