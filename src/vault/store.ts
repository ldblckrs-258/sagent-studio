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
import { createWriteQueue } from './write-queue'
import { invalidate as invalidateClients } from '../ai/client-cache'

export type VaultStatus = 'locked' | 'unlocking' | 'unlocked' | 'recovering'
export type VaultPresence = 'none' | 'complete' | 'partial'

export interface VaultState {
  status: VaultStatus
  settings: Settings | null
  unlockGeneration: number
  error: string | null
  setup(password: string): Promise<void>
  unlock(password: string): Promise<void>
  lock(): Promise<void>
  update(patch: DeepPartial<Settings>): Promise<void>
  recover(): Promise<void>
  clearError(): void
}

let key: CryptoKey | null = null
let createInFlight: Promise<unknown> | null = null
const writeQueue = createWriteQueue()

function newKdfParams(): KdfParams {
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: DEFAULT_ITERATIONS,
    salt: randomBytes(SALT_BYTES),
  }
}

async function requestPersistence(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist()
    }
  } catch {
    return false
  }
  return false
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
  const persisted = await requestPersistence()
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
    await createInFlight
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

async function unlockInternal(password: string): Promise<Settings> {
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
  key = derived
  return settings
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

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  return writeQueue.enqueue(task)
}

async function drainWrites(): Promise<void> {
  await writeQueue.drain()
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
  settings: null,
  unlockGeneration: 0,
  error: null,

  async setup(password) {
    set({ status: 'unlocking', error: null })
    try {
      const derived = await createVaultOnce(password)
      key = derived
      set((state) => ({
        status: 'unlocked',
        settings: defaultSettings(),
        unlockGeneration: state.unlockGeneration + 1,
        error: null,
      }))
    } catch (error) {
      key = null
      set({ status: 'locked', settings: null, error: describeError(error) })
      throw error
    }
  },

  async unlock(password) {
    set({ status: 'unlocking', error: null })
    try {
      const settings = await unlockInternal(password)
      set((state) => ({
        status: 'unlocked',
        settings,
        unlockGeneration: state.unlockGeneration + 1,
        error: null,
      }))
    } catch (error) {
      key = null
      const status: VaultStatus = error instanceof CorruptVaultError ? 'recovering' : 'locked'
      set({ status, settings: null, error: describeError(error) })
      throw error
    }
  },

  async lock() {
    await drainWrites()
    key = null
    invalidateClients()
    set((state) => ({
      status: 'locked',
      settings: null,
      error: null,
      unlockGeneration: state.unlockGeneration + 1,
    }))
  },

  async update(patch) {
    if (!key) throw new VaultLockedError()
    await enqueueWrite(async () => {
      const currentKey = key
      if (!currentKey) throw new VaultLockedError()
      const latest = get().settings
      if (!latest) throw new VaultLockedError()
      const next = deepMerge(latest, patch)
      await persistSettings(currentKey, next)
      set({ settings: next })
    })
  },

  async recover() {
    await drainWrites()
    key = null
    await db.transaction('rw', db.vault, db.meta, async () => {
      await db.vault.clear()
      await db.meta.clear()
    })
    set((state) => ({
      status: 'locked',
      settings: null,
      error: null,
      unlockGeneration: state.unlockGeneration + 1,
    }))
  },

  clearError() {
    set({ error: null })
  },
}))

export const vaultInternals = {
  getKey: () => key,
  reset: async () => {
    await db.vault.clear()
    await db.meta.clear()
    key = null
    createInFlight = null
    writeQueue.reset()
  },
  hasKey: () => key !== null,
}

export type { VaultRecord, MetaRecord }
