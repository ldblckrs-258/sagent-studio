import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { ViewerError, ViewerLoading } from './feedback'
import { targetTitle } from './kind'
import { UNCAPPED, useObjectUrl, useWorkspaceBlob } from './load'

export function MediaView({
  fs,
  target,
  kind,
}: {
  fs: WorkspaceFs | null
  target: FileTarget
  kind: 'audio' | 'video'
}) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const blob = useWorkspaceBlob(fs, workspacePath, UNCAPPED)
  const objectUrl = useObjectUrl(blob.status === 'ready' ? blob.value : null)
  const src = remoteUrl ?? objectUrl

  if (blob.status === 'error') return <ViewerError message={blob.error ?? 'The media could not be loaded.'} />
  if (!src) return <ViewerLoading label={`Loading ${kind}…`} />

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto bg-paper-sunk p-3">
      {kind === 'audio' ? (
        <audio controls src={src} className="w-full max-w-lg" aria-label={targetTitle(target)} />
      ) : (
        <video controls src={src} className="max-h-full max-w-full" aria-label={targetTitle(target)} />
      )}
    </div>
  )
}
