import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { EncryptedBlob, KdfParams } from './types'

export interface VaultRecord {
  id: 'settings'
  blob: EncryptedBlob
  updatedAt: number
}

export interface MetaRecord {
  id: 'kdf'
  kdfParams: KdfParams
  canary: EncryptedBlob
  settingsVersion: number
  /** Last known grant. `null` means the browser exposed no persistent storage API. */
  persistedStorage: boolean | null
  createdAt: number
  updatedAt: number
}

export interface ThreadRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

export interface SkillRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

export interface ToolRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

export interface FsHandleRecord {
  id: string
  handle: FileSystemDirectoryHandle
  updatedAt: number
}

export interface JournalRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

export interface DocumentRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

export interface MemoryRecord {
  id: string
  blob: EncryptedBlob
  updatedAt: number
}

/**
 * One encrypted chunk. `dims` is the only plaintext per-chunk number: it is the
 * vector width, which lets hydration validate a vector without decrypting the
 * document blob. It carries no content.
 */
export interface ChunkRecord {
  id: string
  docId: string
  ordinal: number
  dims: number
  text: EncryptedBlob
  vector: EncryptedBlob
  updatedAt: number
}

type DatabaseBlockedListener = () => void

let blocked = false
const blockedListeners = new Set<DatabaseBlockedListener>()

/** True once a schema upgrade was blocked by another open tab. */
export function isDatabaseBlocked(): boolean {
  return blocked
}

/** Subscribes to the "another tab is holding the old schema" notice. */
export function subscribeDatabaseBlocked(listener: DatabaseBlockedListener): () => void {
  blockedListeners.add(listener)
  return () => {
    blockedListeners.delete(listener)
  }
}

function notifyDatabaseBlocked(): void {
  blocked = true
  for (const listener of blockedListeners) listener()
}

/** Test seam: reset the one-shot blocked flag between cases. */
export function resetDatabaseBlocked(): void {
  blocked = false
}

export class VaultDatabase extends Dexie {
  vault!: Table<VaultRecord, string>
  meta!: Table<MetaRecord, string>
  threads!: Table<ThreadRecord, string>
  skills!: Table<SkillRecord, string>
  tools!: Table<ToolRecord, string>
  fs!: Table<FsHandleRecord, string>
  journals!: Table<JournalRecord, string>
  documents!: Table<DocumentRecord, string>
  chunks!: Table<ChunkRecord, string>
  memories!: Table<MemoryRecord, string>

  constructor(name = 'sagent-vault') {
    super(name)
    this.version(1).stores({
      vault: 'id',
      meta: 'id',
    })
    this.version(2).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
    })
    this.version(3).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
    })
    this.version(4).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
    })
    this.version(5).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
      journals: 'id, updatedAt',
    })
    this.version(6).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
      journals: 'id, updatedAt',
      documents: 'id, updatedAt',
      chunks: 'id, docId, [docId+ordinal]',
    })
    this.version(7).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
      journals: 'id, updatedAt',
      documents: 'id, updatedAt',
      chunks: 'id, docId, [docId+ordinal]',
      memories: 'id, updatedAt',
    })

    // Another tab opening a higher schema version fires `versionchange` here.
    // Close this connection rather than let it keep writing against the old
    // schema; the opening tab then sees `blocked` until this one releases it.
    this.on('versionchange', () => {
      this.close()
    })
    this.on('blocked', () => {
      notifyDatabaseBlocked()
    })
  }
}

export const db = new VaultDatabase()

export const VAULT_ID = 'settings' as const
export const META_ID = 'kdf' as const
