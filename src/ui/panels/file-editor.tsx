import { useState } from 'react'
import type { FormEvent } from 'react'
import { ExternalLink, FileText, Link2, X } from 'lucide-react'
import { targetKey, useFileViewStore } from '../../session/file-view-state'
import { useWorkspaceStore } from '../../session/workspace-state'
import { Badge, Button, EmptyState, Input } from '../primitives'
import { DocxView } from '../file-view/docx-view'
import { DiagramView } from '../file-view/diagram-view'
import { EmbedView } from '../file-view/embed-view'
import { HtmlView } from '../file-view/html-view'
import { ImageView } from '../file-view/image-view'
import { JsonView } from '../file-view/json-view'
import { kindForTarget, kindLabel, normalizeRemoteInput, targetTitle } from '../file-view/kind'
import { MarkdownView } from '../file-view/markdown-view'
import { MediaView } from '../file-view/media-view'
import { SheetView } from '../file-view/sheet-view'
import { TextView } from '../file-view/text-view'

function UrlBar({ onOpen }: { onOpen(url: string): void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = normalizeRemoteInput(value)
    if (!url) {
      setError('Enter an http(s) link.')
      return
    }
    setError(null)
    setValue('')
    onOpen(url)
  }

  return (
    <form onSubmit={submit} className="flex shrink-0 flex-col gap-1 border-b border-rule p-2">
      <div className="flex items-center gap-1.5">
        <Link2 size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
        <Input
          size="sm"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a link…"
          aria-label="Open a link"
          spellCheck={false}
        />
        <Button size="sm" variant="secondary" type="submit">
          Open
        </Button>
      </div>
      {error ? (
        <span role="alert" className="font-mono text-xs text-danger">
          {error}
        </span>
      ) : null}
    </form>
  )
}

export function FilePanel({ onBrowseWorkspace }: { onBrowseWorkspace(): void }) {
  const target = useFileViewStore((s) => s.target)
  const revision = useFileViewStore((s) => s.revision)
  const openUrl = useFileViewStore((s) => s.openUrl)
  const clear = useFileViewStore((s) => s.clear)
  const fs = useWorkspaceStore((s) => s.fs)

  if (!target) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <UrlBar onOpen={openUrl} />
        <div className="p-3">
          <EmptyState
            icon={<FileText size={18} strokeWidth={1.5} />}
            title="No file open"
            hint="Pick a file in the Workspace panel, or paste a link above to preview it here."
            action={
              <Button size="sm" variant="secondary" onClick={onBrowseWorkspace}>
                Browse workspace
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const kind = kindForTarget(target)
  const url = target.kind === 'url' ? target.url : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-rule px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={targetTitle(target)}>
            {targetTitle(target)}
          </span>
          <Badge size="sm">{kindLabel(kind)}</Badge>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open link in new tab"
              title="Open in new tab"
              className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
            >
              <ExternalLink size={15} strokeWidth={1.75} />
            </a>
          ) : null}
          <button
            type="button"
            aria-label="Close file"
            title="Close file"
            onClick={clear}
            className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1" key={targetKey(target, revision)}>
        {kind === 'text' ? <TextView fs={fs} target={target} /> : null}
        {kind === 'html' ? <HtmlView fs={fs} target={target} /> : null}
        {kind === 'image' ? <ImageView fs={fs} target={target} /> : null}
        {kind === 'audio' || kind === 'video' ? (
          <MediaView fs={fs} target={target} kind={kind} />
        ) : null}
        {kind === 'csv' || kind === 'spreadsheet' ? (
          <SheetView fs={fs} target={target} kind={kind} />
        ) : null}
        {kind === 'docx' ? <DocxView fs={fs} target={target} /> : null}
        {kind === 'markdown' ? <MarkdownView fs={fs} target={target} /> : null}
        {kind === 'json' ? <JsonView fs={fs} target={target} /> : null}
        {kind === 'diagram' ? <DiagramView fs={fs} target={target} /> : null}
        {kind === 'embed' ? <EmbedView target={target} /> : null}
      </div>
    </div>
  )
}
