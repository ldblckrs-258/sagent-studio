import { create } from 'zustand'
import { sameDirectory } from '../workspace/handle'
import { memoryPersistence } from './store'
import type { MemoryPersistence } from './store'
import {
  MEMORY_BODY_MAX,
  MEMORY_IMPORTANT_BUDGET,
  MEMORY_MAX_COUNT,
  MEMORY_TITLE_MAX,
  MemoryConflictError,
  MemoryLimitError,
  MemoryNotFoundError,
  MemoryScopeError,
  MemoryValidationError,
} from './types'
import type { Memory, MemoryDraft, MemoryScope, MemorySource } from './types'

export type MemoryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MemoryScopeEntry {
  handle: FileSystemDirectoryHandle
  label: string
}

export interface MemoryCreateOptions {
  source: MemorySource
  threadId?: string
  handle?: FileSystemDirectoryHandle | null
}

export interface MemoryUpdateOptions {
  source: MemorySource
  handle?: FileSystemDirectoryHandle | null
}

export interface MemoryState {
  memories: Memory[]
  scopes: Record<string, MemoryScopeEntry>
  status: MemoryStatus
  error: string | null
  hydrate(): Promise<void>
  clear(): void
  resolveScope(handle: FileSystemDirectoryHandle | null): Promise<string | null>
  ensureScope(handle: FileSystemDirectoryHandle): Promise<string>
  visible(scopeId: string | null): Memory[]
  create(draft: MemoryDraft, options: MemoryCreateOptions): Promise<Memory>
  update(id: string, patch: Partial<MemoryDraft>, options: MemoryUpdateOptions): Promise<Memory>
  remove(id: string): Promise<void>
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function newMemoryId(taken: (id: string) => boolean): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(10))
    const id = `mem_${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`
    if (!taken(id)) return id
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function newestFirst(a: Memory, b: Memory): number {
  return b.updatedAt - a.updatedAt
}

function scopeIdOf(scope: MemoryScope): string | null {
  return scope.kind === 'workspace' ? scope.scopeId : null
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new MemoryValidationError('A memory title is required.')
  const title = raw.trim()
  if (title.length === 0) throw new MemoryValidationError('A memory title is required.')
  if (/[\n\r\v\f\u0085\u2028\u2029]/.test(title)) {
    throw new MemoryValidationError('A memory title must be a single line.')
  }
  if (title.length > MEMORY_TITLE_MAX) {
    throw new MemoryValidationError(
      `A memory title is at most ${MEMORY_TITLE_MAX} characters (received ${title.length}).`,
    )
  }
  return title
}

function normalizeBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new MemoryValidationError('A memory body is required.')
  const body = raw.trim()
  if (body.length === 0) throw new MemoryValidationError('A memory body is required.')
  if (body.length > MEMORY_BODY_MAX) {
    throw new MemoryValidationError(
      `A memory body is at most ${MEMORY_BODY_MAX} characters (received ${body.length}).`,
    )
  }
  return body
}

function assertScopeKind(value: unknown): asserts value is MemoryDraft['scope'] {
  if (value !== 'global' && value !== 'workspace') {
    throw new MemoryValidationError('A memory scope is either "global" or "workspace".')
  }
}

export function createMemoryStore(persistence: MemoryPersistence) {
  return create<MemoryState>((set, get) => {
    let generation = 0
    let chain: Promise<unknown> = Promise.resolve()

    function serial<T>(task: () => Promise<T>): Promise<T> {
      const run = chain.then(task, task)
      chain = run.catch(() => undefined)
      return run
    }

    async function findScope(handle: FileSystemDirectoryHandle): Promise<string | null> {
      for (const [scopeId, entry] of Object.entries(get().scopes)) {
        if (await sameDirectory(entry.handle, handle)) return scopeId
      }
      return null
    }

    async function claimScope(handle: FileSystemDirectoryHandle): Promise<string> {
      const existing = await findScope(handle)
      if (existing) return existing
      const scopeId = crypto.randomUUID()
      const before = generation
      await persistence.saveScope(scopeId, handle)
      if (generation === before) {
        set((state) => ({
          scopes: { ...state.scopes, [scopeId]: { handle, label: handle.name } },
        }))
      }
      return scopeId
    }

    function checkTarget(input: {
      scopeId: string | null
      fresh: boolean
      title: string
      body: string
      important: boolean
      ignoreId?: string
    }): void {
      const peers = input.fresh
        ? []
        : get().memories.filter(
            (memory) => memory.id !== input.ignoreId && scopeIdOf(memory.scope) === input.scopeId,
          )
      const lowered = input.title.toLowerCase()
      const duplicate = peers.find((memory) => memory.title.toLowerCase() === lowered)
      if (duplicate) {
        throw new MemoryConflictError(
          duplicate.id,
          `A memory titled "${duplicate.title}" already exists in this scope (${duplicate.id}).`,
        )
      }
      if (!input.important) return
      const used = peers
        .filter((memory) => memory.important)
        .reduce((total, memory) => total + memory.body.length, 0)
      if (used + input.body.length > MEMORY_IMPORTANT_BUDGET) {
        throw new MemoryLimitError(
          'important',
          `Important memories in this scope would use ${used + input.body.length} of ${MEMORY_IMPORTANT_BUDGET} characters.`,
        )
      }
    }

    function scopeFor(scopeId: string | null, handle: FileSystemDirectoryHandle | null): MemoryScope {
      if (scopeId === null) return { kind: 'global' }
      const label = get().scopes[scopeId]?.label ?? handle?.name ?? ''
      return { kind: 'workspace', scopeId, label }
    }

    function commit(before: number, memory: Memory): void {
      if (generation !== before) return
      set((state) => ({
        memories: [...state.memories.filter((entry) => entry.id !== memory.id), memory],
      }))
    }

    return {
      memories: [],
      scopes: {},
      status: 'idle',
      error: null,

      async hydrate() {
        const before = ++generation
        set({ status: 'loading', error: null })
        try {
          const [memories, handles] = await Promise.all([
            persistence.list(),
            persistence.listScopes(),
          ])
          const used = new Set(
            memories.map((memory) => scopeIdOf(memory.scope)).filter((id) => id !== null),
          )
          const scopes: Record<string, MemoryScopeEntry> = {}
          for (const { scopeId, handle } of handles) {
            if (used.has(scopeId)) {
              scopes[scopeId] = { handle, label: handle.name }
            } else {
              await persistence.removeScope(scopeId)
            }
          }
          if (generation !== before) return
          set({ memories, scopes, status: 'ready', error: null })
        } catch (error) {
          if (generation !== before) return
          set({ memories: [], scopes: {}, status: 'error', error: describe(error) })
        }
      },

      clear() {
        generation += 1
        set({ memories: [], scopes: {}, status: 'idle', error: null })
      },

      async resolveScope(handle) {
        if (!handle) return null
        return findScope(handle)
      },

      ensureScope(handle) {
        return serial(() => claimScope(handle))
      },

      visible(scopeId) {
        return get()
          .memories.filter((memory) => {
            const own = scopeIdOf(memory.scope)
            return own === null || own === scopeId
          })
          .sort(newestFirst)
      },

      create(draft, options) {
        return serial(async () => {
          const before = generation
          const title = normalizeTitle(draft.title)
          const body = normalizeBody(draft.body)
          const important = draft.important === true
          assertScopeKind(draft.scope)
          if (get().memories.length >= MEMORY_MAX_COUNT) {
            throw new MemoryLimitError(
              'count',
              `At most ${MEMORY_MAX_COUNT} memories can be stored; forget a stale one first.`,
            )
          }
          const handle = options.handle ?? null
          let scopeId: string | null = null
          if (draft.scope === 'workspace') {
            if (!handle) throw new MemoryScopeError()
            scopeId = await findScope(handle)
          }
          const fresh = draft.scope === 'workspace' && scopeId === null
          checkTarget({ scopeId, fresh, title, body, important })
          if (fresh && handle) scopeId = await claimScope(handle)
          const now = Date.now()
          const memory: Memory = {
            id: newMemoryId((id) => get().memories.some((entry) => entry.id === id)),
            title,
            body,
            scope: scopeFor(scopeId, handle),
            important,
            source: options.source,
            ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
            createdAt: now,
            updatedAt: now,
          }
          await persistence.save(memory)
          commit(before, memory)
          return memory
        })
      },

      update(id, patch, options) {
        return serial(async () => {
          const before = generation
          const current = get().memories.find((memory) => memory.id === id)
          if (!current) throw new MemoryNotFoundError(id)
          const title = patch.title === undefined ? current.title : normalizeTitle(patch.title)
          const body = patch.body === undefined ? current.body : normalizeBody(patch.body)
          const important = patch.important === undefined ? current.important : patch.important === true
          const handle = options.handle ?? null
          const currentScopeId = scopeIdOf(current.scope)
          let scopeId = currentScopeId
          let fresh = false
          if (patch.scope !== undefined) {
            assertScopeKind(patch.scope)
            if (patch.scope === 'global') {
              scopeId = null
            } else if (handle) {
              scopeId = await findScope(handle)
              fresh = scopeId === null
            } else if (currentScopeId === null) {
              throw new MemoryScopeError()
            }
          }
          checkTarget({ scopeId, fresh, title, body, important, ignoreId: id })
          if (fresh && handle) scopeId = await claimScope(handle)
          const memory: Memory = {
            ...current,
            title,
            body,
            important,
            scope: scopeId === currentScopeId ? current.scope : scopeFor(scopeId, handle),
            source: options.source,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
          }
          await persistence.save(memory)
          commit(before, memory)
          return memory
        })
      },

      remove(id) {
        return serial(async () => {
          const before = generation
          if (!get().memories.some((memory) => memory.id === id)) throw new MemoryNotFoundError(id)
          await persistence.remove(id)
          if (generation !== before) return
          set((state) => ({ memories: state.memories.filter((memory) => memory.id !== id) }))
        })
      },
    }
  })
}

export const useMemoryStore = createMemoryStore(memoryPersistence)
