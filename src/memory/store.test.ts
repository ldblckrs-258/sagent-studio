import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import { CorruptVaultError, VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { encryptRecord } from '../vault/records'
import { useVaultStore, vaultInternals } from '../vault/store'
import {
  listMemories,
  listScopeHandles,
  removeMemory,
  removeScopeHandle,
  saveMemory,
  saveScopeHandle,
  scopeHandleId,
} from './store'
import { MemoryParseError } from './types'
import type { Memory } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }
const MARKER_TITLE = 'MARKER_TITLE_7f3a9c'
const MARKER_BODY = 'MARKER_BODY_d41e02'

async function installKey(password = 'memory-password'): Promise<void> {
  keyring.reset()
  keyring.install(await deriveKey(password, KDF))
}

function memory(patch: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_aaaaaaaaaa',
    title: MARKER_TITLE,
    body: MARKER_BODY,
    scope: { kind: 'global' },
    important: false,
    source: 'model',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function folder(name: string): FileSystemDirectoryHandle {
  return { name, kind: 'directory' } as unknown as FileSystemDirectoryHandle
}

function asText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

describe('encrypted memory store', () => {
  beforeEach(async () => {
    await db.memories.clear()
    await db.fs.clear()
    await installKey()
  })

  it('stores no title or body plaintext in the raw row', async () => {
    await saveMemory(memory())
    const row = await db.memories.get('mem_aaaaaaaaaa')
    expect(row).toBeDefined()
    expect(Object.keys(row ?? {}).sort()).toEqual(['blob', 'id', 'updatedAt'])
    const raw = `${JSON.stringify(row)}${asText(row!.blob.ciphertext)}${asText(row!.blob.iv)}`
    expect(raw).not.toContain(MARKER_TITLE)
    expect(raw).not.toContain(MARKER_BODY)
  })

  it('round-trips save, list, and remove', async () => {
    const first = memory()
    const second = memory({
      id: 'mem_bbbbbbbbbb',
      title: 'Second',
      scope: { kind: 'workspace', scopeId: 's1', label: 'proj' },
      important: true,
      threadId: 't1',
    })
    await saveMemory(first)
    await saveMemory(second)
    const listed = await listMemories()
    expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([first, second])

    await removeMemory(first.id)
    expect(await listMemories()).toEqual([second])
  })

  it('refuses to read a record under a different key', async () => {
    await saveMemory(memory())
    await installKey('another-password')
    await expect(listMemories()).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('refuses to read or write while the vault is locked', async () => {
    await saveMemory(memory())
    keyring.clear()
    await expect(listMemories()).rejects.toBeInstanceOf(VaultLockedError)
    await expect(saveMemory(memory({ id: 'mem_cccccccccc' }))).rejects.toBeInstanceOf(
      VaultLockedError,
    )
  })

  it('rejects an envelope newer than this build understands', async () => {
    const future = JSON.stringify({ version: 2, memory: memory() })
    await db.memories.put({
      id: 'mem_aaaaaaaaaa',
      blob: await encryptRecord(future, 'memory:mem_aaaaaaaaaa'),
      updatedAt: 1,
    })
    await expect(listMemories()).rejects.toBeInstanceOf(MemoryParseError)
  })

  it('rejects a record whose id does not match its row', async () => {
    const swapped = JSON.stringify({ version: 1, memory: memory({ id: 'mem_zzzzzzzzzz' }) })
    await db.memories.put({
      id: 'mem_aaaaaaaaaa',
      blob: await encryptRecord(swapped, 'memory:mem_aaaaaaaaaa'),
      updatedAt: 1,
    })
    await expect(listMemories()).rejects.toBeInstanceOf(MemoryParseError)
  })

  it('lists only memscope handles from the folder table', async () => {
    await db.fs.put({ id: 'thread:t1', handle: folder('other'), updatedAt: 1 })
    await saveScopeHandle('s1', folder('proj'))
    expect((await db.fs.get(scopeHandleId('s1')))?.handle.name).toBe('proj')

    const scopes = await listScopeHandles()
    expect(scopes.map((entry) => [entry.scopeId, entry.handle.name])).toEqual([['s1', 'proj']])

    await removeScopeHandle('s1')
    expect(await listScopeHandles()).toEqual([])
    expect(await db.fs.get('thread:t1')).toBeDefined()
  })
})

describe('vault recovery', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
  })

  it('wipes every memory and memscope handle', async () => {
    await useVaultStore.getState().setup('memory-wipe-password')
    await saveMemory(memory())
    await saveScopeHandle('s1', folder('proj'))

    await useVaultStore.getState().recover()

    expect(await db.memories.count()).toBe(0)
    expect(await listScopeHandles()).toEqual([])
  })
})
