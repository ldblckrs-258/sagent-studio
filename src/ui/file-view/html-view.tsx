import { useState } from 'react'
import { Save } from 'lucide-react'
import type { FileTarget } from '../../session/file-view-state'
import { useFileViewStore } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { ArtifactHtmlRuntime } from './artifact-html-runtime'
import { ViewerError, ViewerLoading, ViewerNotice } from './feedback'
import { PREVIEW_SANDBOX } from './sandbox'
import { useTextDocument } from './use-text-document'
import { ViewerModeToggle } from './viewer-mode-toggle'

export function HtmlView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const doc = useTextDocument(fs, workspacePath)
  // A path the model has presented this session renders in the opaque-origin
  // runtime; its authorship is sticky, so a later user reopen cannot upgrade it
  // to the same-origin preview sandbox.
  const authored = useFileViewStore((s) =>
    s.target?.kind === 'workspace' ? s.authored.has(s.target.path) : false,
  )

  if (remoteUrl !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewerNotice>
          Previewing {remoteUrl}. Sites can refuse to be embedded; use Open in new tab if it stays blank.
        </ViewerNotice>
        <iframe
          title={remoteUrl}
          src={remoteUrl}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 border-0 bg-white"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-2">
        <div className="flex items-center gap-2">
          <ViewerModeToggle mode={mode} onChange={setMode} />
          {doc.dirty ? (
            <span className="size-1.5 rounded-full bg-caution" aria-label="Unsaved changes" />
          ) : null}
        </div>
        <div className="flex items-center gap-1">
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
      </div>

      {doc.error ? <ViewerError message={doc.error} /> : null}

      <div className="min-h-0 flex-1">
        {doc.loading ? (
          <ViewerLoading />
        ) : mode === 'preview' ? (
          authored ? (
            <ArtifactHtmlRuntime html={doc.draft} />
          ) : (
            <iframe
              title={workspacePath ?? 'HTML preview'}
              srcDoc={doc.draft}
              sandbox={PREVIEW_SANDBOX}
              className="h-full w-full border-0 bg-white"
            />
          )
        ) : (
          <MonacoEditor
            value={doc.draft}
            onChange={doc.setDraft}
            language="html"
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}
