import { create } from 'zustand'
import { WorkspaceError, WorkspacePermissionError, WorkspaceUnsupportedError } from '../workspace/errors'
import type { WorkspaceFs } from '../workspace/fs'
import {
  isPickerAvailable,
  pickWorkspace,
  restoreWorkspace,
  restoreWorkspaceHandle,
  sameDirectory,
  saveWorkspaceHandle,
  threadHandleId,
} from '../workspace/handle'

export type WorkspaceStatus = 'none' | 'ready' | 'denied' | 'unsupported'

export interface WorkspaceState {
  fs: WorkspaceFs | null
  folderName: string | null
  status: WorkspaceStatus
  error: string | null
  /** The conversation the live folder belongs to; `null` when none is open. */
  boundThreadId: string | null
  pick(): Promise<void>
  restore(): Promise<void>
  regrant(): Promise<void>
  markDenied(message?: string): void
  setFs(fs: WorkspaceFs | null): void
  /**
   * Makes `threadId` the owner of the live folder: restores the folder stored
   * for it, or adopts the current one when it has none yet.
   */
  bindThread(threadId: string | null): Promise<void>
  /** Drops the in-memory reference only. Never deletes a persisted `db.fs` handle. */
  clear(): Promise<void>
}

export interface WorkspaceDeps {
  pick(): Promise<WorkspaceFs>
  restore(): Promise<WorkspaceFs | null>
  restoreThread(threadId: string): Promise<WorkspaceFs | null>
  saveThread(threadId: string, fs: WorkspaceFs): Promise<void>
  isAvailable(): boolean
}

function describe(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message
  if (error instanceof Error) return error.message
  return 'The workspace operation failed.'
}

/**
 * Query-only permission check. Unlike `WorkspaceFs.ensurePermission`, this never
 * requests: a reload has no user gesture, so requesting would either no-op or
 * throw. A handle without a query API is treated as granted (fake handles).
 */
async function hasReadPermission(fs: WorkspaceFs): Promise<boolean> {
  const query = fs.handle.queryPermission
  if (typeof query !== 'function') return true
  try {
    return (await query.call(fs.handle, { mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * Two restored handles for one folder are different objects, so identity alone
 * would report a change on every conversation switch and needlessly rebuild the
 * sandbox and drop the journal.
 */
async function sameFolder(a: WorkspaceFs | null, b: WorkspaceFs | null): Promise<boolean> {
  if (!a || !b) return a === b
  return sameDirectory(a.handle, b.handle)
}

export function createWorkspaceStore(deps: WorkspaceDeps) {
  return create<WorkspaceState>((set, get) => {
    async function adopt(fs: WorkspaceFs): Promise<void> {
      if (await hasReadPermission(fs)) {
        set({ fs, folderName: fs.handle.name, status: 'ready', error: null })
      } else {
        set({
          fs,
          folderName: fs.handle.name,
          status: 'denied',
          error: new WorkspacePermissionError().message,
        })
      }
    }

    return {
      fs: null,
      folderName: null,
      status: 'none',
      error: null,
      boundThreadId: null,

      async pick() {
        if (!deps.isAvailable()) {
          set({ status: 'unsupported', error: new WorkspaceUnsupportedError().message })
          return
        }
        try {
          const fs = await deps.pick()
          set({ fs, folderName: fs.handle.name, status: 'ready', error: null })
          const threadId = get().boundThreadId
          if (threadId) await deps.saveThread(threadId, fs)
        } catch (error) {
          // A cancelled picker is not a denial; leave the previous state intact.
          if (error instanceof DOMException && error.name === 'AbortError') {
            set({ status: 'none', error: null })
            return
          }
          set({ status: 'denied', error: describe(error) })
        }
      },

      async restore() {
        const threadId = get().boundThreadId
        try {
          const fs = threadId ? await deps.restoreThread(threadId) : await deps.restore()
          if (!fs) {
            set({ fs: null, folderName: null, status: 'none', error: null })
            return
          }
          await adopt(fs)
        } catch (error) {
          set({ fs: null, folderName: null, status: 'none', error: describe(error) })
        }
      },

      async bindThread(threadId) {
        set({ boundThreadId: threadId })
        if (!threadId) return
        try {
          const stored = await deps.restoreThread(threadId)
          // A switch that lands elsewhere while this one awaited wins.
          if (get().boundThreadId !== threadId) return
          if (!stored) {
            const current = get().fs
            // A conversation with no folder of its own keeps the one on screen
            // and takes ownership of it, which is also how threads created
            // before per-conversation folders get one.
            if (current) await deps.saveThread(threadId, current)
            return
          }
          if (await sameFolder(get().fs, stored)) return
          if (get().boundThreadId !== threadId) return
          await adopt(stored)
        } catch (error) {
          if (get().boundThreadId !== threadId) return
          set({ fs: null, folderName: null, status: 'none', error: describe(error) })
        }
      },

      async regrant() {
        const { fs } = get()
        if (!fs) return
        try {
          await fs.ensurePermission('readwrite')
          set({ status: 'ready', error: null })
        } catch (error) {
          set({ status: 'denied', error: describe(error) })
        }
      },

      markDenied(message) {
        set({ status: 'denied', error: message ?? new WorkspacePermissionError().message })
      },

      setFs(fs) {
        set({
          fs,
          folderName: fs?.handle.name ?? null,
          status: fs ? 'ready' : 'none',
          error: null,
        })
      },

      async clear() {
        set({ fs: null, folderName: null, status: 'none', error: null, boundThreadId: null })
      },
    }
  })
}

export const useWorkspaceStore = createWorkspaceStore({
  pick: pickWorkspace,
  restore: restoreWorkspace,
  restoreThread: (threadId) => restoreWorkspaceHandle(threadHandleId(threadId)),
  saveThread: (threadId, fs) => saveWorkspaceHandle(threadHandleId(threadId), fs.handle),
  isAvailable: isPickerAvailable,
})
