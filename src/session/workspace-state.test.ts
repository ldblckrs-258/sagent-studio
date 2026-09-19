import { describe, expect, it } from 'vitest'
import { db } from '../vault/db'
import { WorkspacePermissionError, WorkspaceUnsupportedError } from '../workspace/errors'
import { createWorkspaceStore } from './workspace-state'
import type { WorkspaceDeps } from './workspace-state'
import type { WorkspaceFs } from '../workspace/fs'
import { WORKSPACE_HANDLE_ID } from '../workspace/handle'

function fakeFs(name: string, permission: PermissionState = 'granted'): WorkspaceFs {
  const handle = {
    name,
    queryPermission: async () => permission,
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
  }
}

function deps(overrides: Partial<WorkspaceDeps>): WorkspaceDeps {
  return {
    isAvailable: () => true,
    pick: async () => fakeFs('picked'),
    restore: async () => null,
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
