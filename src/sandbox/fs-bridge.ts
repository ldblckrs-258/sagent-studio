import { journaledWrite } from '../workspace/journal-io'
import type { WorkspaceApi } from '../tools/types'
import { SandboxError, assertSerializable } from './protocol'
import type { FromWorker, ToWorker } from './protocol'

export type FsCall = Extract<FromWorker, { kind: 'fs.call' }>

/**
 * A workspace, or a live getter for one. The getter form exists because the
 * sandbox session is built before the user grants a folder; resolving at call
 * time keeps the bridge correct instead of permanently binding "no workspace".
 */
export type WorkspaceSource = WorkspaceApi | undefined | (() => WorkspaceApi | undefined)

export interface PendingFs {
  cancel(error: Error): void
}

function resolveWorkspace(source: WorkspaceSource): WorkspaceApi | undefined {
  return typeof source === 'function' ? source() : source
}

export function executeFsCall(
  source: WorkspaceSource,
  handle: FsCall,
): Promise<string> {
  const workspace = resolveWorkspace(source)
  if (!workspace) {
    return Promise.reject(
      new SandboxError(
        'No workspace folder is open, so the sandbox has no `fs`/`workspace` bridge. Ask the user to open a workspace folder, then retry.',
      ),
    )
  }
  if (handle.op === 'read') return workspace.readFile(handle.path)
  if (handle.op === 'write') {
    return journaledWrite(workspace, handle.path, handle.data ?? '').then(() => '')
  }
  return workspace.list(handle.path).then((entries) => JSON.stringify(entries))
}

export function attachFsHandler(
  source: WorkspaceSource,
  handle: FsCall,
  pendingFs: Set<PendingFs>,
  safePost: (message: ToWorker) => void,
): void {
  let cancel: (error: Error) => void = () => {}
  const deferred = new Promise<string>((resolve, reject) => {
    cancel = reject
    executeFsCall(source, handle).then(resolve, reject)
  })
  const entry: PendingFs = { cancel: (error) => cancel(error) }
  pendingFs.add(entry)

  deferred.then(
    (data) => {
      pendingFs.delete(entry)
      assertSerializable(data, 'fs.result.data')
      safePost({ kind: 'fs.result', requestId: handle.requestId, ok: true, data })
    },
    (error: unknown) => {
      pendingFs.delete(entry)
      safePost({
        kind: 'fs.error',
        requestId: handle.requestId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    },
  )
}
