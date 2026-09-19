import { create } from 'zustand'
import { useVaultStore } from '../vault/store'
import type { ChatThread } from './types'

export type ChatStoreStatus = 'idle' | 'streaming'

export interface ChatState {
  threads: Record<string, ChatThread>
  activeThreadId: string | null
  status: ChatStoreStatus
  error: string | null
  setThread(thread: ChatThread): void
  removeThread(id: string): void
  setActiveThread(id: string | null): void
  setStatus(status: ChatStoreStatus): void
  setError(error: string | null): void
  clear(): void
}

export const useChatStore = create<ChatState>((set) => ({
  threads: {},
  activeThreadId: null,
  status: 'idle',
  error: null,

  setThread(thread) {
    set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }))
  },

  removeThread(id) {
    set((state) => {
      const threads = { ...state.threads }
      delete threads[id]
      return {
        threads,
        activeThreadId: state.activeThreadId === id ? null : state.activeThreadId,
      }
    })
  },

  setActiveThread(id) {
    set({ activeThreadId: id })
  },

  setStatus(status) {
    set({ status })
  },

  setError(error) {
    set({ error })
  },

  clear() {
    set({ threads: {}, activeThreadId: null, status: 'idle', error: null })
  },
}))

const aborters = new Set<() => void>()

export function registerAbortAll(abort: () => void): () => void {
  aborters.add(abort)
  return () => {
    aborters.delete(abort)
  }
}

function abortAll(): void {
  for (const abort of aborters) abort()
}

useVaultStore.subscribe((state, previous) => {
  if (previous.status === 'unlocked' && state.status !== 'unlocked') {
    abortAll()
    useChatStore.getState().clear()
  }
})
