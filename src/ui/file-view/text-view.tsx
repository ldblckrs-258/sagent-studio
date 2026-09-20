import { Save } from 'lucide-react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { ViewerError, ViewerLoading } from './feedback'
import { languageFor } from './language'
import { useRemoteText } from './load'
import { useTextDocument } from './use-text-document'

function SaveBar({
  byteLength,
  dirty,
  saving,
  onSave,
  onRevert,
}: {
  byteLength: number
  dirty: boolean
  saving: boolean
  onSave(): void
  onRevert(): void
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-2">
      <span className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {byteLength.toLocaleString()} bytes
        {dirty ? (
          <span className="size-1.5 rounded-full bg-caution" aria-label="Unsaved changes" />
        ) : null}
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="quiet"
          disabled={!dirty || saving}
          onClick={onSave}
          icon={<Save size={14} strokeWidth={1.75} />}
        >
          Save
        </Button>
        <Button size="sm" variant="quiet" disabled={!dirty} onClick={onRevert}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function TextView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const doc = useTextDocument(fs, workspacePath)
  const remote = useRemoteText(remoteUrl)

  if (workspacePath !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <SaveBar
          byteLength={doc.byteLength}
          dirty={doc.dirty}
          saving={doc.saving}
          onSave={() => void doc.save()}
          onRevert={doc.revert}
        />
        {doc.error ? <ViewerError message={doc.error} /> : null}
        <div className="min-h-0 flex-1">
          {doc.loading ? (
            <ViewerLoading />
          ) : (
            <MonacoEditor
              value={doc.draft}
              onChange={doc.setDraft}
              language={languageFor(workspacePath)}
              className="h-full"
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-rule px-2 font-mono text-xs text-faint">
        Read-only preview
      </div>
      {remote.error ? <ViewerError message={remote.error} /> : null}
      <div className="min-h-0 flex-1">
        {remote.status === 'loading' || remote.status === 'idle' ? (
          <ViewerLoading />
        ) : remote.status === 'ready' ? (
          <MonacoEditor
            value={remote.value ?? ''}
            onChange={() => undefined}
            language={languageFor(remoteUrl ?? '')}
            readOnly
            className="h-full"
          />
        ) : null}
      </div>
    </div>
  )
}
