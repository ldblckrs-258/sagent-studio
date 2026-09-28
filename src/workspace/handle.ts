import { db } from '../vault/db'
import { WorkspaceUnsupportedError } from './errors'
import { createWorkspaceFs } from './fs'
import type { WorkspaceFs } from './fs'

export const WORKSPACE_HANDLE_ID = 'workspace' as const

/**
 * The slot a conversation's folder is stored under. The plain `workspace` slot
 * stays the last-picked folder, so a reload with no conversation open still
 * restores something.
 */
export function threadHandleId(threadId: string): string {
  return `thread:${threadId}`
}

export async function sameDirectory(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (a === b) return true
  const isSameEntry = a.isSameEntry
  if (typeof isSameEntry !== 'function') return false
  try {
    return await isSameEntry.call(a, b)
  } catch {
    return false
  }
}

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

export async function saveWorkspaceHandle(
  id: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await db.fs.put({ id, handle, updatedAt: Date.now() })
}

export async function restoreWorkspaceHandle(id: string): Promise<WorkspaceFs | null> {
  const record = await db.fs.get(id)
  if (!record) return null
  return createWorkspaceFs(record.handle)
}

export async function restoreWorkspace(): Promise<WorkspaceFs | null> {
  return restoreWorkspaceHandle(WORKSPACE_HANDLE_ID)
}

export async function clearWorkspaceHandle(id: string = WORKSPACE_HANDLE_ID): Promise<void> {
  await db.fs.delete(id)
}
