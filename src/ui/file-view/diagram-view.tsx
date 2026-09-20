import { useEffect, useRef, useState } from 'react'
import { Save } from 'lucide-react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { loadMermaid, sanitizeDiagramSvg } from './diagram'
import { ViewerError, ViewerLoading } from './feedback'
import { describeError, useRemoteText } from './load'
import { useTextDocument } from './use-text-document'
import { ViewerModeToggle } from './viewer-mode-toggle'

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string }

export function DiagramView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const doc = useTextDocument(fs, workspacePath)
  const remote = useRemoteText(remoteUrl)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [render, setRender] = useState<RenderState>({ status: 'loading' })
  const renderId = useRef(0)

  const isWorkspace = workspacePath !== null
  const source = isWorkspace ? doc.draft : (remote.value ?? '')
  const loading = isWorkspace
    ? doc.loading
    : remote.status === 'loading' || remote.status === 'idle'
  const loadError = isWorkspace ? doc.error : remote.error

  useEffect(() => {
    if (mode !== 'preview' || loading) return
    let cancelled = false
    void (async () => {
      // Deferred to a microtask so the loading write does not run synchronously
      // in the effect body (react-hooks/set-state-in-effect).
      await Promise.resolve()
      if (cancelled) return
      setRender({ status: 'loading' })
      try {
        const mermaid = await loadMermaid()
        const { svg } = await mermaid.default.render(`diagram-${renderId.current++}`, source)
        const clean = await sanitizeDiagramSvg(svg)
        if (!cancelled) setRender({ status: 'ready', svg: clean })
      } catch (error) {
        if (!cancelled) setRender({ status: 'error', message: describeError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, mode, loading])

  const sourceEditor = (
    <MonacoEditor
      value={source}
      onChange={isWorkspace ? doc.setDraft : () => undefined}
      language="plaintext"
      readOnly={!isWorkspace}
      className="h-full"
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-2">
        <ViewerModeToggle mode={mode} onChange={setMode} />
        {isWorkspace ? (
          <div className="flex items-center gap-1">
            {doc.dirty ? (
              <span className="size-1.5 rounded-full bg-caution" aria-label="Unsaved changes" />
            ) : null}
            <Button
              size="sm"
              variant="quiet"
              disabled={!doc.dirty || doc.saving}
              onClick={() => void doc.save()}
              icon={<Save size={14} strokeWidth={1.75} />}
            >
              Save
            </Button>
            <Button size="sm" variant="quiet" disabled={!doc.dirty} onClick={doc.revert}>
              Cancel
            </Button>
          </div>
        ) : (
          <span className="font-mono text-xs text-faint">Read-only preview</span>
        )}
      </div>

      {loadError ? <ViewerError message={loadError} /> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <ViewerLoading />
        ) : mode === 'source' ? (
          sourceEditor
        ) : render.status === 'loading' ? (
          <ViewerLoading label="Rendering diagram…" />
        ) : render.status === 'error' ? (
          <div className="flex h-full min-h-0 flex-col">
            <ViewerError message={render.message} />
            <div className="min-h-0 flex-1">{sourceEditor}</div>
          </div>
        ) : (
          <div className="p-3" dangerouslySetInnerHTML={{ __html: render.svg }} />
        )}
      </div>
    </div>
  )
}
