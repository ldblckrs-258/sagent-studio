import type { WorkspaceApi } from '../tools/types'
import { SandboxError, assertSerializable } from './protocol'
import type { FromWorker, ToWorker } from './protocol'

export type FsCall = Extract<FromWorker, { kind: 'fs.call' }>

export interface PendingFs {
  cancel(error: Error): void
}

export function executeFsCall(
  workspace: WorkspaceApi | undefined,
  handle: FsCall,
): Promise<string> {
  if (!workspace) {
    return Promise.reject(new SandboxError('No workspace is available to the sandbox.'))
  }
  if (handle.op === 'read') return workspace.readFile(handle.path)
  if (handle.op === 'write') {
    return workspace.writeFile(handle.path, handle.data ?? '').then(() => '')
  }
  return workspace.list(handle.path).then((entries) => JSON.stringify(entries))
}

export function attachFsHandler(
  workspace: WorkspaceApi | undefined,
  handle: FsCall,
  pendingFs: Set<PendingFs>,
  safePost: (message: ToWorker) => void,
): void {
  let cancel: (error: Error) => void = () => {}
  const deferred = new Promise<string>((resolve, reject) => {
    cancel = reject
    executeFsCall(workspace, handle).then(resolve, reject)
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
