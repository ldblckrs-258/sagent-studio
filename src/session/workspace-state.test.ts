import { describe, expect, it } from 'vitest'
import { db } from '../vault/db'
import { WorkspacePermissionError, WorkspaceUnsupportedError } from '../workspace/errors'
import { createWorkspaceStore } from './workspace-state'
import type { WorkspaceDeps } from './workspace-state'
import type { WorkspaceFs } from '../workspace/fs'
import { WORKSPACE_HANDLE_ID } from '../workspace/handle'

function fakeFs(
  name: string,
  permission: PermissionState = 'granted',
  folderId: string = name,
): WorkspaceFs {
  const handle = {
    name,
    queryPermission: async () => permission,
    isSameEntry: async (other: { folderId?: string }) => other.folderId === folderId,
    folderId,
  } as unknown as FileSystemDirectoryHandle
  return {
    kind: 'workspace',
    handle,
    ensurePermission: async () => {},
    list: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
    makeDir: async () => {},
    remove: async () => {},
    stat: async () => ({ path: '', kind: 'directory', size: 0 }),
    move: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
    copy: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
    search: async () => ({ hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 }),
  }
}

function deps(overrides: Partial<WorkspaceDeps>): WorkspaceDeps {
  return {
    isAvailable: () => true,
    pick: async () => fakeFs('picked'),
    restore: async () => null,
    restoreThread: async () => null,
    saveThread: async () => {},
    ...overrides,
  }
}

describe('workspace store', () => {
  it('picks a folder and stores the folder name', async () => {
    const store = createWorkspaceStore(deps({ pick: async () => fakeFs('my-folder') }))
    await store.getState().pick()
    expect(store.getState()).toMatchObject({ status: 'ready', folderName: 'my-folder' })
    expect(store.getState().fs).not.toBeNull()
  })

  it('enters a denied state when the pick is refused', async () => {
    const store = createWorkspaceStore(
      deps({
        pick: async () => {
          throw new WorkspacePermissionError()
        },
      }),
    )
    await store.getState().pick()
    expect(store.getState().status).toBe('denied')
    expect(store.getState().error).toContain('Permission')
  })

  it('treats a cancelled pick as a no-op, not a denial', async () => {
    const store = createWorkspaceStore(
      deps({
        pick: async () => {
          throw new DOMException('cancelled', 'AbortError')
        },
      }),
    )
    await store.getState().pick()
    expect(store.getState()).toMatchObject({ status: 'none', error: null })
  })

  it('reports unsupported when the picker is unavailable', async () => {
    const store = createWorkspaceStore(deps({ isAvailable: () => false }))
    await store.getState().pick()
    expect(store.getState().status).toBe('unsupported')
    expect(store.getState().error).toBe(new WorkspaceUnsupportedError().message)
  })

  it('restores to none when no handle is stored', async () => {
    const store = createWorkspaceStore(deps({ restore: async () => null }))
    await store.getState().restore()
    expect(store.getState()).toMatchObject({ status: 'none', fs: null })
  })

  it('restores to ready when permission is granted', async () => {
    const store = createWorkspaceStore(deps({ restore: async () => fakeFs('restored', 'granted') }))
    await store.getState().restore()
    expect(store.getState()).toMatchObject({ status: 'ready', folderName: 'restored' })
  })

  it('restores to denied when permission is not granted', async () => {
    const store = createWorkspaceStore(deps({ restore: async () => fakeFs('restored', 'denied') }))
    await store.getState().restore()
    expect(store.getState().status).toBe('denied')
    expect(store.getState().fs).not.toBeNull()
  })

  it('regrants and clears the denied state', async () => {
    const fs = fakeFs('folder', 'denied')
    const store = createWorkspaceStore(deps({ restore: async () => fs }))
    await store.getState().restore()
    expect(store.getState().status).toBe('denied')

    await store.getState().regrant()
    expect(store.getState().status).toBe('ready')
  })

  it('marks denied on demand', () => {
    const store = createWorkspaceStore(deps({}))
    store.getState().markDenied('No access')
    expect(store.getState()).toMatchObject({ status: 'denied', error: 'No access' })
  })

  it('restores the folder bound to the conversation being opened', async () => {
    const folders: Record<string, WorkspaceFs> = {
      t1: fakeFs('folder-a'),
      t2: fakeFs('folder-b'),
    }
    const store = createWorkspaceStore(
      deps({ restoreThread: async (threadId) => folders[threadId] ?? null }),
    )

    await store.getState().bindThread('t2')
    expect(store.getState().folderName).toBe('folder-b')

    await store.getState().bindThread('t1')
    expect(store.getState()).toMatchObject({ folderName: 'folder-a', status: 'ready' })
  })

  it('binds the live folder to a conversation that has none stored yet', async () => {
    const saved: Array<[string, string]> = []
    const store = createWorkspaceStore(
      deps({
        pick: async () => fakeFs('folder-a'),
        saveThread: async (threadId, fs) => {
          saved.push([threadId, fs.handle.name])
        },
      }),
    )

    await store.getState().bindThread('t1')
    await store.getState().pick()
    expect(saved).toEqual([['t1', 'folder-a']])
    expect(store.getState().folderName).toBe('folder-a')
  })

  it('adopts the folder on screen for a conversation stored before folders were per-conversation', async () => {
    const saved: Array<[string, string]> = []
    const store = createWorkspaceStore(
      deps({
        restore: async () => fakeFs('legacy-folder'),
        saveThread: async (threadId, fs) => {
          saved.push([threadId, fs.handle.name])
        },
      }),
    )

    await store.getState().restore()
    await store.getState().bindThread('t-old')
    expect(saved).toEqual([['t-old', 'legacy-folder']])
    expect(store.getState().folderName).toBe('legacy-folder')
  })

  it('keeps the live handle when two conversations share one folder', async () => {
    const store = createWorkspaceStore(
      deps({
        restore: async () => fakeFs('shared', 'granted', 'same'),
        restoreThread: async () => fakeFs('shared', 'granted', 'same'),
      }),
    )
    await store.getState().restore()
    const before = store.getState().fs

    await store.getState().bindThread('t2')
    expect(store.getState().fs).toBe(before)
  })

  it('ignores a restore that lands after the user switched away', async () => {
    const gate = { release: () => {} }
    const opened = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    const store = createWorkspaceStore(
      deps({
        restoreThread: async (threadId) => {
          if (threadId === 't-slow') {
            await opened
            return fakeFs('slow-folder')
          }
          return fakeFs('fast-folder')
        },
      }),
    )

    const slow = store.getState().bindThread('t-slow')
    await store.getState().bindThread('t-fast')
    gate.release()
    await slow
    expect(store.getState().folderName).toBe('fast-folder')
  })

  it('restores the bound conversation folder, not the last-picked one, on refresh', async () => {
    const store = createWorkspaceStore(
      deps({
        restore: async () => fakeFs('last-picked'),
        restoreThread: async () => fakeFs('conversation-folder'),
      }),
    )
    await store.getState().bindThread('t1')
    await store.getState().restore()
    expect(store.getState().folderName).toBe('conversation-folder')
  })

  it('clear drops the in-memory reference without deleting the persisted handle', async () => {
    await db.fs.put({ id: WORKSPACE_HANDLE_ID, handle: {} as FileSystemDirectoryHandle, updatedAt: 1 })
    const store = createWorkspaceStore(deps({ restore: async () => fakeFs('folder') }))
    await store.getState().restore()
    expect(store.getState().fs).not.toBeNull()

    await store.getState().clear()
    expect(store.getState()).toMatchObject({ status: 'none', fs: null, folderName: null })
    await expect(db.fs.get(WORKSPACE_HANDLE_ID)).resolves.toBeDefined()
    await db.fs.delete(WORKSPACE_HANDLE_ID)
  })
})
