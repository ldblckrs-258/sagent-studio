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
  persistedStorage: boolean
  createdAt: number
  updatedAt: number
}

export class VaultDatabase extends Dexie {
  vault!: Table<VaultRecord, string>
  meta!: Table<MetaRecord, string>

  constructor(name = 'sagent-vault') {
    super(name)
    this.version(1).stores({
      vault: 'id',
      meta: 'id',
    })
  }
}

export const db = new VaultDatabase()

export const VAULT_ID = 'settings' as const
export const META_ID = 'kdf' as const
