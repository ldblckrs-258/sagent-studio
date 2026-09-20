import { useState } from 'react'
import { Save } from 'lucide-react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { ViewerError, ViewerLoading } from './feedback'
import { languageFor } from './language'
import { useRemoteText } from './load'
import { useTextDocument } from './use-text-document'
import { ViewerModeToggle } from './viewer-mode-toggle'

/*
  `react-markdown` escapes raw HTML by default and `rehype-raw` is deliberately
  not enabled, so a model-authored document cannot inject markup into the app.
*/
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-ink">{children}</h3>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-ink">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5 text-sm text-ink">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5 text-sm text-ink">{children}</ol>,
  li: ({ children }) => <li className="my-0.5 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-rule pl-3 text-sm text-muted">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-accent underline" rel="noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-rule" />,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-rule bg-paper-sunk px-2 py-1 text-left font-medium text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-rule px-2 py-1 text-ink">{children}</td>,
  code: ({ className, children }) =>
    typeof className === 'string' && className.startsWith('language-') ? (
      <code className={`font-mono text-xs ${className}`}>{children}</code>
    ) : (
      <code className="rounded-sm bg-paper-sunk px-1 py-0.5 font-mono text-xs text-ink">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-auto rounded-sm border border-rule bg-paper-sunk p-2">
      {children}
    </pre>
  ),
}

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
          <div className="px-3 py-1">
            <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
              {source}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  )
}
