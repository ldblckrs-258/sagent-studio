import { create } from 'zustand'
import { WorkspaceError, WorkspacePermissionError, WorkspaceUnsupportedError } from '../workspace/errors'
import type { WorkspaceFs } from '../workspace/fs'
import { isPickerAvailable, pickWorkspace, restoreWorkspace } from '../workspace/handle'

export type WorkspaceStatus = 'none' | 'ready' | 'denied' | 'unsupported'

export interface WorkspaceState {
  fs: WorkspaceFs | null
  folderName: string | null
  status: WorkspaceStatus
  error: string | null
  pick(): Promise<void>
  restore(): Promise<void>
  regrant(): Promise<void>
  markDenied(message?: string): void
  setFs(fs: WorkspaceFs | null): void
  /** Drops the in-memory reference only. Never deletes the persisted `db.fs` handle. */
  clear(): Promise<void>
}

export interface WorkspaceDeps {
  pick(): Promise<WorkspaceFs>
  restore(): Promise<WorkspaceFs | null>
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

export function createWorkspaceStore(deps: WorkspaceDeps) {
  return create<WorkspaceState>((set, get) => ({
    fs: null,
    folderName: null,
    status: 'none',
    error: null,

    async pick() {
      if (!deps.isAvailable()) {
        set({ status: 'unsupported', error: new WorkspaceUnsupportedError().message })
        return
      }
      try {
        const fs = await deps.pick()
        set({ fs, folderName: fs.handle.name, status: 'ready', error: null })
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
      try {
        const fs = await deps.restore()
        if (!fs) {
          set({ fs: null, folderName: null, status: 'none', error: null })
          return
        }
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
      } catch (error) {
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
      set({ fs: null, folderName: null, status: 'none', error: null })
    },
  }))
}

export const useWorkspaceStore = createWorkspaceStore({
  pick: pickWorkspace,
  restore: restoreWorkspace,
  isAvailable: isPickerAvailable,
})
