import { db } from '../vault/db'
import { WorkspaceUnsupportedError } from './errors'
import { createWorkspaceFs } from './fs'
import type { WorkspaceFs } from './fs'

export const WORKSPACE_HANDLE_ID = 'workspace' as const

export function isPickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export async function pickWorkspace(): Promise<WorkspaceFs> {
  const picker = typeof window === 'undefined' ? undefined : window.showDirectoryPicker
  if (typeof picker !== 'function') throw new WorkspaceUnsupportedError()
  const handle = await picker({ mode: 'readwrite' })
  await db.fs.put({ id: WORKSPACE_HANDLE_ID, handle, updatedAt: Date.now() })
  return createWorkspaceFs(handle)
}

export async function restoreWorkspace(): Promise<WorkspaceFs | null> {
  const record = await db.fs.get(WORKSPACE_HANDLE_ID)
  if (!record) return null
  return createWorkspaceFs(record.handle)
}

export async function clearWorkspaceHandle(): Promise<void> {
  await db.fs.delete(WORKSPACE_HANDLE_ID)
}
