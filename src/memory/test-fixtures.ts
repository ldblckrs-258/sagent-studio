import { VaultLockedError } from '../vault/errors'
import { createMemoryStore } from './state'
import type { MemoryPersistence } from './store'
import type { Memory } from './types'

export type FakeFolder = FileSystemDirectoryHandle & { folderId: string }

export function fakeFolder(name: string, folderId: string = name): FakeFolder {
  return {
    name,
    kind: 'directory',
    folderId,
    isSameEntry: async (other: { folderId?: string }) => other.folderId === folderId,
  } as unknown as FakeFolder
}

export function seededMemory(patch: Partial<Memory> & { id: string }): Memory {
  return {
    title: patch.id,
    body: 'body',
    scope: { kind: 'global' },
    important: false,
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

export interface MemorySeed {
  memories?: Memory[]
  scopes?: Record<string, FakeFolder>
}

export function fakeMemoryPersistence(seed: MemorySeed = {}) {
  const memories = new Map((seed.memories ?? []).map((memory) => [memory.id, memory]))
  const scopes = new Map(Object.entries(seed.scopes ?? {}))
  const calls = { saveScope: 0, removeScope: [] as string[] }
  let locked = false
  const persistence: MemoryPersistence = {
    list: async () => [...memories.values()],
    save: async (memory) => {
      if (locked) throw new VaultLockedError()
      memories.set(memory.id, memory)
    },
    remove: async (id) => {
      if (locked) throw new VaultLockedError()
      memories.delete(id)
    },
    listScopes: async () =>
      [...scopes.entries()].map(([scopeId, handle]) => ({ scopeId, handle })),
    saveScope: async (scopeId, handle) => {
      calls.saveScope += 1
      scopes.set(scopeId, handle as FakeFolder)
    },
    removeScope: async (scopeId) => {
      calls.removeScope.push(scopeId)
      scopes.delete(scopeId)
    },
  }
  return {
    persistence,
    memories,
    scopes,
    calls,
    lock: () => {
      locked = true
    },
  }
}

export async function readyMemoryStore(seed?: MemorySeed) {
  const fake = fakeMemoryPersistence(seed)
  const store = createMemoryStore(fake.persistence)
  await store.getState().hydrate()
  return { ...fake, store }
}
