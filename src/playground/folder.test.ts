import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../vault/db'
import type { FsHandleRecord } from '../vault/db'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { readWorkspaceBlob } from '../workspace/fs'
import { WORKSPACE_HANDLE_ID } from '../workspace/handle'
import { PLAYGROUND_FOLDER_ID, choosePlaygroundFolder, restorePlaygroundFolder, saveToFolder } from './folder'

describe('playground folder', () => {
  const slots = new Map<string, FsHandleRecord>()

  beforeEach(() => {
    slots.clear()
    vi.spyOn(db.fs, 'put').mockImplementation((async (record: FsHandleRecord) => {
      slots.set(record.id, record)
      return record.id
    }) as unknown as typeof db.fs.put)
    vi.spyOn(db.fs, 'get').mockImplementation((async (id: string) => slots.get(id)) as unknown as typeof db.fs.get)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores the chosen folder under its own slot and never replaces the conversation workspace', async () => {
    const fake = createFakeWorkspace()
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => fake.handle) })
    const fs = await choosePlaygroundFolder()
    expect(fs.handle).toBe(fake.handle)
    expect(slots.get(PLAYGROUND_FOLDER_ID)?.handle).toBe(fake.handle)
    expect(slots.has(WORKSPACE_HANDLE_ID)).toBe(false)
    expect((await restorePlaygroundFolder())?.handle).toBe(fake.handle)
  })

  it('writes the original bytes under a unique name', async () => {
    const fake = createFakeWorkspace()
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => fake.handle) })
    const fs = await choosePlaygroundFolder()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    expect(await saveToFolder(fs, 'out.png', new Blob([bytes]))).toBe('out.png')
    expect(await saveToFolder(fs, 'out.png', new Blob([bytes]))).toBe('out-1.png')
    const saved = await readWorkspaceBlob(fs, 'out.png')
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(bytes)
  })

  it('reports an unsupported browser instead of throwing a TypeError', async () => {
    vi.stubGlobal('window', {})
    await expect(choosePlaygroundFolder()).rejects.toMatchObject({ name: 'WorkspaceUnsupportedError' })
  })
})
