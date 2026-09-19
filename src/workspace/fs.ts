import type { WorkspaceEntry, WorkspaceStat } from '../tools/types'
import {
  WorkspaceLimitError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspacePermissionError,
} from './errors'

declare global {
  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
  }
  interface Window {
    showDirectoryPicker?(options?: {
      mode?: 'read' | 'readwrite'
    }): Promise<FileSystemDirectoryHandle>
  }
}

export const DEFAULT_SIZE_CAP = 2 * 1024 * 1024

const SEGMENT = /^[^<>:"|?*\0\\/]+$/

export type PermissionMode = 'read' | 'readwrite'

export function resolveSegments(path: string): string[] {
  if (path.includes('\0')) throw new WorkspacePathError(path)
  if (path.startsWith('/') || path.startsWith('\\')) throw new WorkspacePathError(path)
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('\\\\')) throw new WorkspacePathError(path)
  const segments = path.split('/').filter((segment) => segment !== '')
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      throw new WorkspacePathError(path)
    }
  }
  return segments
}

function mapDomError(error: unknown, path: string): never {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      throw new WorkspacePermissionError()
    }
    if (error.name === 'NotFoundError') throw new WorkspaceNotFoundError(path)
  }
  throw error
}

function joinPath(segments: readonly string[], name: string): string {
  return [...segments, name].join('/')
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode,
): Promise<void> {
  const query = handle.queryPermission
  const request = handle.requestPermission
  if (typeof query !== 'function' && typeof request !== 'function') return
  try {
    if (typeof query === 'function' && (await query.call(handle, { mode })) === 'granted') return
    if (typeof request === 'function' && (await request.call(handle, { mode })) === 'granted') return
  } catch (error) {
    mapDomError(error, '')
  }
  throw new WorkspacePermissionError()
}

export interface WorkspaceFs {
  readonly kind: 'workspace'
  readonly handle: FileSystemDirectoryHandle
  ensurePermission(mode: PermissionMode): Promise<void>
  list(path: string): Promise<WorkspaceEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  makeDir(path: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<WorkspaceStat>
}

class FileWorkspaceFs implements WorkspaceFs {
  readonly kind = 'workspace' as const
  readonly handle: FileSystemDirectoryHandle
  private readonly sizeCap: number

  constructor(handle: FileSystemDirectoryHandle, sizeCap: number) {
    this.handle = handle
    this.sizeCap = sizeCap
  }

  async ensurePermission(mode: PermissionMode): Promise<void> {
    await ensurePermission(this.handle, mode)
  }

  private async directoryFor(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    await this.ensurePermission(create ? 'readwrite' : 'read')
    let directory = this.handle
    try {
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create })
      }
    } catch (error) {
      mapDomError(error, segments.join('/'))
    }
    return directory
  }

  private async fileFor(
    segments: string[],
  ): Promise<{ file: File; parent: FileSystemDirectoryHandle; name: string }> {
    if (segments.length === 0) throw new WorkspacePathError('')
    const parent = await this.directoryFor(segments.slice(0, -1), false)
    const name = segments[segments.length - 1]
    try {
      const handle = await parent.getFileHandle(name)
      return { file: await handle.getFile(), parent, name }
    } catch (error) {
      mapDomError(error, segments.join('/'))
    }
  }

  async list(path: string): Promise<WorkspaceEntry[]> {
    const segments = resolveSegments(path)
    const directory = await this.directoryFor(segments, false)
    const entries: WorkspaceEntry[] = []
    try {
      for await (const child of directory.values()) {
        entries.push({
          name: child.name,
          path: joinPath(segments, child.name),
          kind: child.kind,
        })
      }
    } catch (error) {
      mapDomError(error, path)
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  async readFile(path: string): Promise<string> {
    const { file } = await this.fileFor(resolveSegments(path))
    if (file.size > this.sizeCap) throw new WorkspaceLimitError(path)
    const text = await file.text()
    if (new TextEncoder().encode(text).byteLength > this.sizeCap) {
      throw new WorkspaceLimitError(path)
    }
    return text
  }

  async writeFile(path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength > this.sizeCap) throw new WorkspaceLimitError(path)
    const segments = resolveSegments(path)
    if (segments.length === 0) throw new WorkspacePathError(path)
    const parent = await this.directoryFor(segments.slice(0, -1), true)
    const name = segments[segments.length - 1]
    try {
      const handle = await parent.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(content)
      await writable.close()
    } catch (error) {
      mapDomError(error, path)
    }
  }

  async makeDir(path: string): Promise<void> {
    const segments = resolveSegments(path)
    if (segments.length === 0) throw new WorkspacePathError(path)
    await this.directoryFor(segments, true)
  }

  async remove(path: string): Promise<void> {
    const segments = resolveSegments(path)
    if (segments.length === 0) throw new WorkspacePathError(path)
    const parent = await this.directoryFor(segments.slice(0, -1), false)
    const name = segments[segments.length - 1]
    try {
      await parent.removeEntry(name, { recursive: true })
    } catch (error) {
      mapDomError(error, path)
    }
  }

  async stat(path: string): Promise<WorkspaceStat> {
    const segments = resolveSegments(path)
    await this.ensurePermission('read')
    if (segments.length === 0) return { path: '', kind: 'directory', size: 0 }
    const parent = await this.directoryFor(segments.slice(0, -1), false)
    const name = segments[segments.length - 1]
    try {
      const handle = await parent.getFileHandle(name)
      const file = await handle.getFile()
      return { path, kind: 'file', size: file.size }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TypeMismatchError') {
        return { path, kind: 'directory', size: 0 }
      }
      mapDomError(error, path)
    }
  }
}

export function createWorkspaceFs(
  handle: FileSystemDirectoryHandle,
  options: { sizeCap?: number } = {},
): WorkspaceFs {
  return new FileWorkspaceFs(handle, options.sizeCap ?? DEFAULT_SIZE_CAP)
}
