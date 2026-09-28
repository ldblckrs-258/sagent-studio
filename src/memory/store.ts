import { db } from '../vault/db'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { MemoryParseError, isMemory } from './types'
import type { Memory } from './types'

export const MEMORY_ENVELOPE_VERSION = 1

export const MEMORY_SCOPE_PREFIX = 'memscope:'

export function scopeHandleId(scopeId: string): string {
  return `${MEMORY_SCOPE_PREFIX}${scopeId}`
}

function aadSeed(id: string): string {
  return `memory:${id}`
}

function parseEnvelope(raw: string, id: string): Memory {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new MemoryParseError('The decrypted memory was not valid JSON.', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MemoryParseError('The memory envelope was not an object.')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MemoryParseError('The memory envelope version is invalid.')
  }
  if (version > MEMORY_ENVELOPE_VERSION) {
    throw new MemoryParseError(`Memory envelope version ${version} is newer than this app supports.`)
  }
  const memory = (parsed as { memory?: unknown }).memory
  if (!isMemory(memory) || memory.id !== id) {
    throw new MemoryParseError('The stored memory is malformed.')
  }
  return memory
}

export async function saveMemory(memory: Memory): Promise<void> {
  if (!isMemory(memory)) throw new MemoryParseError('The memory is malformed.')
  await vaultWriteQueue.enqueue(async () => {
    const envelope = JSON.stringify({ version: MEMORY_ENVELOPE_VERSION, memory })
    const blob = await encryptRecord(envelope, aadSeed(memory.id))
    await db.memories.put({ id: memory.id, blob, updatedAt: memory.updatedAt })
  })
}

export async function listMemories(): Promise<Memory[]> {
  const rows = await db.memories.toArray()
  return Promise.all(
    rows.map(async (row) => parseEnvelope(await decryptRecord(row.blob, aadSeed(row.id)), row.id)),
  )
}

export async function removeMemory(id: string): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    await db.memories.delete(id)
  })
}

export async function saveScopeHandle(
  scopeId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await db.fs.put({ id: scopeHandleId(scopeId), handle, updatedAt: Date.now() })
}

export async function listScopeHandles(): Promise<
  Array<{ scopeId: string; handle: FileSystemDirectoryHandle }>
> {
  const rows = await db.fs.where('id').startsWith(MEMORY_SCOPE_PREFIX).toArray()
  return rows.map((row) => ({
    scopeId: row.id.slice(MEMORY_SCOPE_PREFIX.length),
    handle: row.handle,
  }))
}

export async function removeScopeHandle(scopeId: string): Promise<void> {
  await db.fs.delete(scopeHandleId(scopeId))
}

export interface MemoryPersistence {
  list(): Promise<Memory[]>
  save(memory: Memory): Promise<void>
  remove(id: string): Promise<void>
  listScopes(): Promise<Array<{ scopeId: string; handle: FileSystemDirectoryHandle }>>
  saveScope(scopeId: string, handle: FileSystemDirectoryHandle): Promise<void>
  removeScope(scopeId: string): Promise<void>
}

export const memoryPersistence: MemoryPersistence = {
  list: listMemories,
  save: saveMemory,
  remove: removeMemory,
  listScopes: listScopeHandles,
  saveScope: saveScopeHandle,
  removeScope: removeScopeHandle,
}
