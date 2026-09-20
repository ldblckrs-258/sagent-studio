import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { ViewerError, ViewerLoading } from './feedback'
import { targetTitle } from './kind'
import { UNCAPPED, useObjectUrl, useWorkspaceBlob } from './load'

export function ImageView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const blob = useWorkspaceBlob(fs, workspacePath, UNCAPPED)
  const objectUrl = useObjectUrl(blob.status === 'ready' ? blob.value : null)
  const src = remoteUrl ?? objectUrl

  if (blob.status === 'error') return <ViewerError message={blob.error ?? 'The image could not be loaded.'} />
  if (!src) return <ViewerLoading label="Loading image…" />

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-paper-sunk p-3">
      <img
        src={src}
        alt={targetTitle(target)}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  )
}
