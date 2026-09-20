import { useState } from 'react'
import { ChevronRight, Save } from 'lucide-react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'
import { ViewerError, ViewerLoading } from './feedback'
import { MAX_JSON_CHILDREN, jsonChildren, jsonValueLabel, parseJsonDocument } from './json'
import { languageFor } from './language'
import { useRemoteText } from './load'
import { useTextDocument } from './use-text-document'
import { ViewerModeToggle } from './viewer-mode-toggle'

function Scalar({ value }: { value: unknown }) {
  const tone =
    value === null
      ? 'text-faint'
      : typeof value === 'string'
        ? 'text-accent'
        : typeof value === 'number'
          ? 'text-ink'
          : typeof value === 'boolean'
            ? 'text-caution'
            : 'text-muted'
  return <span className={`font-mono text-xs ${tone}`}>{JSON.stringify(value)}</span>
}

/**
 * One JSON value. Objects and arrays collapse; each level renders at most
 * `MAX_JSON_CHILDREN` siblings so a wide document cannot freeze the tab.
 */
function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [visible, setVisible] = useState(MAX_JSON_CHILDREN)

  if (typeof value !== 'object' || value === null) {
    return (
      <div className="flex gap-1.5 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {name !== undefined ? <span className="font-mono text-xs text-muted">{name}:</span> : null}
        <Scalar value={value} />
      </div>
    )
  }

  // Bound the work, not just the render: a wide array must not allocate a tuple
  // for every element before the cap is applied.
  const { shown, total } = jsonChildren(value, visible)
  const remaining = total - shown.length

  return (
    <Collapsible defaultOpen={depth === 0}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-0.5 text-left font-mono text-xs text-muted hover:text-ink">
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-faint transition-transform group-data-[state=open]:rotate-90"
        />
        {name !== undefined ? <span className="text-ink">{name}:</span> : null}
        <span className="text-faint">{jsonValueLabel(value)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {shown.map(([key, child]) => (
          <JsonNode key={key} name={key} value={child} depth={depth + 1} />
        ))}
        {remaining > 0 ? (
          <button
            type="button"
            onClick={() => setVisible((count) => count + MAX_JSON_CHILDREN)}
            className="py-0.5 font-mono text-xs text-accent hover:underline"
            style={{ paddingLeft: (depth + 1) * 12 }}
          >
            Show {Math.min(remaining, MAX_JSON_CHILDREN)} more
          </button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function JsonView({ fs, target }: { fs: WorkspaceFs | null; target: FileTarget }) {
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
  const parsed = parseJsonDocument(source)
  // Invalid JSON cannot be previewed; show the source so the user can fix it and
  // keep the toggle so they can return to the tree afterwards.
  const activeMode = parsed.ok ? mode : 'source'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-2">
        <ViewerModeToggle mode={activeMode} onChange={setMode} />
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
      {!loading && !parsed.ok ? <ViewerError message={parsed.message} /> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <ViewerLoading />
        ) : activeMode === 'source' ? (
          <MonacoEditor
            value={source}
            onChange={isWorkspace ? doc.setDraft : () => undefined}
            language={languageFor(workspacePath ?? remoteUrl ?? '')}
            readOnly={!isWorkspace}
            className="h-full"
          />
        ) : (
          <div className="p-2">
            <JsonNode value={parsed.ok ? parsed.value : null} depth={0} />
          </div>
        )}
      </div>
    </div>
  )
}
