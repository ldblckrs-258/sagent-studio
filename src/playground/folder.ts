import { WorkspaceUnsupportedError } from '../workspace/errors'
import { createWorkspaceFs, uniqueUploadPath, writeWorkspaceBlob } from '../workspace/fs'
import type { WorkspaceFs } from '../workspace/fs'
import { restoreWorkspaceHandle, saveWorkspaceHandle } from '../workspace/handle'

export const PLAYGROUND_FOLDER_ID = 'playground:folder'

export async function choosePlaygroundFolder(): Promise<WorkspaceFs> {
  const picker = typeof window === 'undefined' ? undefined : window.showDirectoryPicker
  if (typeof picker !== 'function') throw new WorkspaceUnsupportedError()
  const handle = await picker({ mode: 'readwrite' })
  await saveWorkspaceHandle(PLAYGROUND_FOLDER_ID, handle)
  return createWorkspaceFs(handle)
}

export function restorePlaygroundFolder(): Promise<WorkspaceFs | null> {
  return restoreWorkspaceHandle(PLAYGROUND_FOLDER_ID)
}

export function ensureFolderPermission(fs: WorkspaceFs): Promise<void> {
  return fs.ensurePermission('readwrite')
}

export async function saveToFolder(fs: WorkspaceFs, name: string, blob: Blob): Promise<string> {
  const path = await uniqueUploadPath(fs, '', name)
  await writeWorkspaceBlob(fs, path, blob)
  return path
}
