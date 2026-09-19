import { useEffect, useMemo, useState } from 'react'
import { Save, X } from 'lucide-react'
import { WorkspaceError } from '../../workspace/errors'
import { DEFAULT_SIZE_CAP } from '../../workspace/fs'
import type { WorkspaceFs } from '../../workspace/fs'
import { MonacoEditor } from '../monaco-editor'
import { Button } from '../primitives'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  toml: 'ini',
}

function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

function messageOf(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message
  if (error instanceof Error) return error.message
  return 'The file operation failed.'
}

export function FileEditorPanel({
  fs,
  path,
  onClose,
}: {
  fs: WorkspaceFs
  path: string
  onClose(): void
}) {
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const content = await fs.readFile(path)
        if (cancelled) return
        setSaved(content)
        setDraft(content)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fs, path])

  const dirty = draft !== saved
  const byteLength = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft])

  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose()
  }

  const save = async () => {
    setSaving(true)
    try {
      await fs.writeFile(path, draft)
      setSaved(draft)
      setError(null)
    } catch (cause) {
      // Keep the draft so the user does not lose text on a failed save.
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-rule px-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-ink">{path}</span>
          {dirty ? <span className="size-1.5 rounded-full bg-caution" aria-label="Unsaved changes" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="quiet"
            disabled={!dirty || saving || loading}
            onClick={() => void save()}
            icon={<Save size={14} strokeWidth={1.75} />}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={!dirty}
            onClick={() => setDraft(saved)}
          >
            Cancel
          </Button>
          <button
            type="button"
            aria-label="Close file"
            onClick={requestClose}
            className="relative inline-flex size-7 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <p className="shrink-0 px-2 py-0.5 font-mono text-xs text-faint">
        {byteLength.toLocaleString()} / {DEFAULT_SIZE_CAP.toLocaleString()} bytes
      </p>

      {error ? (
        <p role="alert" className="shrink-0 border-y border-danger-rule bg-danger-soft px-2 py-1 font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {loading ? (
          <p className="p-3 font-mono text-xs text-faint">Loading file…</p>
        ) : (
          <MonacoEditor
            value={draft}
            onChange={setDraft}
            language={languageFor(path)}
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}
