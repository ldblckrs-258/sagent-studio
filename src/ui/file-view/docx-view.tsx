import { useEffect, useRef, useState } from 'react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { ViewerError, ViewerLoading } from './feedback'
import { describeError, useRemoteBlob, useWorkspaceBlob } from './load'

export function DocxView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const workspaceBlob = useWorkspaceBlob(fs, workspacePath)
  const remoteBlob = useRemoteBlob(remoteUrl)
  const resource = workspacePath !== null ? workspaceBlob : remoteBlob
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || resource.status !== 'ready' || !resource.value) return
    let cancelled = false
    container.replaceChildren()
    setRenderError(null)
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview')
        if (cancelled) return
        await renderAsync(resource.value, container, undefined, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: true,
          ignoreFonts: false,
          renderHeaders: true,
          renderFooters: true,
          experimental: true,
        })
      } catch (cause) {
        if (!cancelled) setRenderError(describeError(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resource])

  if (resource.status === 'error') {
    return <ViewerError message={resource.error ?? 'The document could not be loaded.'} />
  }
  if (resource.status !== 'ready') return <ViewerLoading label="Rendering document…" />

  return (
    <div className="h-full overflow-auto bg-paper-sunk p-3">
      {renderError ? <ViewerError message={renderError} /> : null}
      <div ref={containerRef} className="mx-auto max-w-full bg-white text-black" />
    </div>
  )
}
