import { useState } from 'react'
import { Save } from 'lucide-react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { MarkdownProse } from '../markdown-prose'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { ViewerError, ViewerLoading } from './feedback'
import { languageFor } from './language'
import { useRemoteText } from './load'
import { useTextDocument } from './use-text-document'
import { ViewerModeToggle } from './viewer-mode-toggle'

export function MarkdownView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const doc = useTextDocument(fs, workspacePath)
  const remote = useRemoteText(remoteUrl)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  const isWorkspace = workspacePath !== null
  const source = isWorkspace ? doc.draft : (remote.value ?? '')
  const loading = isWorkspace
    ? doc.loading
    : remote.status === 'loading' || remote.status === 'idle'
  const loadError = isWorkspace ? doc.error : remote.error

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
          <MonacoEditor
            value={source}
            onChange={isWorkspace ? doc.setDraft : () => undefined}
            language={languageFor(workspacePath ?? remoteUrl ?? '')}
            readOnly={!isWorkspace}
            className="h-full"
          />
        ) : (
          <MarkdownProse className="px-3 py-1">{source}</MarkdownProse>
        )}
      </div>
    </div>
  )
}
