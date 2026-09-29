import { sameDirectory } from '../workspace/handle'
import type { BindResult } from './types'

export const PROBE_DIR = '.sagent'
export const PROBE_PREFIX = 'bridge-probe-'

export interface RootBindingDeps {
  handleFor(threadId: string): Promise<FileSystemDirectoryHandle | null>
  verify(nonce: string): Promise<boolean>
  epoch(): number
  connected(): boolean
  nonce?(): string
}

interface CacheEntry {
  epoch: number
  handle: FileSystemDirectoryHandle
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hasWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const query = handle.queryPermission
  if (typeof query !== 'function') return true
  try {
    return (await query.call(handle, { mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

async function writeProbe(handle: FileSystemDirectoryHandle, nonce: string): Promise<FileSystemDirectoryHandle> {
  const dir = await handle.getDirectoryHandle(PROBE_DIR, { create: true })
  const file = await dir.getFileHandle(`${PROBE_PREFIX}${nonce}`, { create: true })
  const writable = await file.createWritable()
  await writable.write(nonce)
  await writable.close()
  return dir
}

export function createRootBinding(deps: RootBindingDeps) {
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<BindResult>>()

  async function probe(threadId: string, handle: FileSystemDirectoryHandle, epoch: number): Promise<BindResult> {
    if (!(await hasWritePermission(handle))) {
      return {
        ok: false,
        code: 'permission_denied',
        message: 'Grant write access in the Workspace panel so the terminal can confirm the folder.',
      }
    }
    const nonce = (deps.nonce ?? randomNonce)()
    let dir: FileSystemDirectoryHandle | null = null
    let matches: boolean
    try {
      dir = await writeProbe(handle, nonce)
      matches = await deps.verify(nonce)
    } catch (error) {
      return {
        ok: false,
        code: 'unavailable',
        message: `Could not confirm the bridge folder: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      if (dir) await dir.removeEntry(`${PROBE_PREFIX}${nonce}`).catch(() => undefined)
    }
    if (!matches) {
      return {
        ok: false,
        code: 'root_mismatch',
        message: `The bridge runs in a different folder than "${handle.name}". Restart it with --root pointing at this conversation's folder.`,
      }
    }
    if (deps.epoch() === epoch) cache.set(threadId, { epoch, handle })
    return { ok: true }
  }

  async function ensureBound(threadId: string): Promise<BindResult> {
    if (!deps.connected()) return { ok: false, code: 'unavailable', message: 'The terminal bridge is not connected.' }
    const handle = await deps.handleFor(threadId)
    if (!handle) {
      return { ok: false, code: 'no_workspace', message: 'Open a workspace folder for this conversation first.' }
    }
    const epoch = deps.epoch()
    const cached = cache.get(threadId)
    if (cached && cached.epoch === epoch && (await sameDirectory(cached.handle, handle))) return { ok: true }
    const running = inflight.get(threadId)
    if (running) return running
    const next = probe(threadId, handle, epoch).finally(() => inflight.delete(threadId))
    inflight.set(threadId, next)
    return next
  }

  return {
    ensureBound,
    reset: () => cache.clear(),
  }
}

export type RootBinding = ReturnType<typeof createRootBinding>
