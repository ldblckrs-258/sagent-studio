import type { MemoryPromptView } from '../chat/context'
import type { MemoryPort } from '../tools/types'
import type { MemoryState } from './state'
import { MEMORY_INDEX_MAX, MEMORY_RECALL_MAX, MemoryNotFoundError } from './types'
import type { Memory } from './types'

export type MemoryPortStore = Pick<
  MemoryState,
  'visible' | 'create' | 'update' | 'remove' | 'resolveScope'
>

export interface MemoryPortOptions {
  store: MemoryPortStore
  handle: FileSystemDirectoryHandle | null
  threadId?: string
}

function matches(memory: Memory, needle: string): boolean {
  return memory.title.toLowerCase().includes(needle) || memory.body.toLowerCase().includes(needle)
}

export function bindMemoryPort(options: MemoryPortOptions & { scopeId: string | null }): MemoryPort {
  const { store, handle, threadId } = options
  let scopeId = options.scopeId

  function visible(): Memory[] {
    return store.visible(scopeId)
  }

  function assertVisible(id: string): void {
    if (!visible().some((memory) => memory.id === id)) throw new MemoryNotFoundError(id)
  }

  function adopt(memory: Memory): Memory {
    if (memory.scope.kind === 'workspace') scopeId = memory.scope.scopeId
    return memory
  }

  return {
    visible,
    async create(draft) {
      return adopt(
        await store.create(draft, {
          source: 'model',
          handle,
          ...(threadId !== undefined ? { threadId } : {}),
        }),
      )
    },
    async update(id, patch) {
      assertVisible(id)
      return adopt(await store.update(id, patch, { source: 'model', handle }))
    },
    async remove(id) {
      assertVisible(id)
      await store.remove(id)
    },
    recall(request) {
      const pool = visible()
      if (request.ids !== undefined) {
        const byId = new Map(pool.map((memory) => [memory.id, memory]))
        const memories: Memory[] = []
        const missing: string[] = []
        for (const id of new Set(request.ids)) {
          const memory = byId.get(id)
          if (memory) memories.push(memory)
          else missing.push(id)
        }
        return { memories, missing }
      }
      const needle = (request.query ?? '').trim().toLowerCase()
      return {
        memories: pool.filter((memory) => matches(memory, needle)).slice(0, MEMORY_RECALL_MAX),
        missing: [],
      }
    },
    promptView(): MemoryPromptView {
      const pool = visible()
      const rest = pool.filter((memory) => !memory.important)
      return {
        important: pool
          .filter((memory) => memory.important)
          .map((memory) => ({
            id: memory.id,
            title: memory.title,
            body: memory.body,
            scopeKind: memory.scope.kind,
          })),
        index: rest.slice(0, MEMORY_INDEX_MAX).map((memory) => ({
          id: memory.id,
          title: memory.title,
          scopeKind: memory.scope.kind,
        })),
        hidden: Math.max(0, rest.length - MEMORY_INDEX_MAX),
      }
    },
  }
}

export async function createMemoryPort(options: MemoryPortOptions): Promise<MemoryPort> {
  const scopeId = await options.store.resolveScope(options.handle)
  return bindMemoryPort({ ...options, scopeId })
}
