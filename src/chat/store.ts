import { create } from 'zustand'
import { useVaultStore } from '../vault/store'
import type { ChatThread } from './types'

export type ChatStoreStatus = 'idle' | 'streaming'

export interface ChatState {
  threads: Record<string, ChatThread>
  activeThreadId: string | null
  status: ChatStoreStatus
  /** Number of in-flight runs across every thread. Derived from `runningThreads`. */
  activeRuns: number
  /** Per-thread in-flight run count, so `isRunning` is correct per conversation. */
  runningThreads: Record<string, number>
  error: string | null
  setThread(thread: ChatThread): void
  removeThread(id: string): void
  setActiveThread(id: string | null): void
  beginRun(threadId: string): void
  endRun(threadId: string): void
  setError(error: string | null): void
  clear(): void
}

export const useChatStore = create<ChatState>((set) => ({
  threads: {},
  activeThreadId: null,
  status: 'idle',
  activeRuns: 0,
  runningThreads: {},
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

  beginRun(threadId) {
    set((state) => ({
      activeRuns: state.activeRuns + 1,
      runningThreads: {
        ...state.runningThreads,
        [threadId]: (state.runningThreads[threadId] ?? 0) + 1,
      },
      status: 'streaming',
    }))
  },

  endRun(threadId) {
    set((state) => {
      const runningThreads = { ...state.runningThreads }
      const remaining = Math.max(0, (runningThreads[threadId] ?? 0) - 1)
      if (remaining === 0) delete runningThreads[threadId]
      else runningThreads[threadId] = remaining
      const activeRuns = Math.max(0, state.activeRuns - 1)
      return { activeRuns, runningThreads, status: activeRuns > 0 ? 'streaming' : 'idle' }
    })
  },

  setError(error) {
    set({ error })
  },

  clear() {
    set({
      threads: {},
      activeThreadId: null,
      status: 'idle',
      activeRuns: 0,
      runningThreads: {},
      error: null,
    })
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

/** Live global abort callbacks. Exposed so the engine-dispose test can assert no leak. */
export function abortersCount(): number {
  return aborters.size
}

useVaultStore.subscribe((state, previous) => {
  if (previous.status === 'unlocked' && state.status !== 'unlocked') {
    abortAll()
    useChatStore.getState().clear()
  }
})
