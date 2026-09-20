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

export class VaultDatabase extends Dexie {
  vault!: Table<VaultRecord, string>
  meta!: Table<MetaRecord, string>
  threads!: Table<ThreadRecord, string>
  skills!: Table<SkillRecord, string>
  tools!: Table<ToolRecord, string>
  fs!: Table<FsHandleRecord, string>
  journals!: Table<JournalRecord, string>

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
  }
}

export const db = new VaultDatabase()

export const VAULT_ID = 'settings' as const
export const META_ID = 'kdf' as const
