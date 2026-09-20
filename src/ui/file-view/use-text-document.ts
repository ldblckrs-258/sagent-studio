import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceFs } from '../../workspace/fs'
import { describeError } from './load'

export interface TextDocument {
  draft: string
  saved: string
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string | null
  byteLength: number
  setDraft(value: string): void
  save(): Promise<void>
  revert(): void
}

/**
 * Loads and edits a text file from the workspace. Mirrors the original File
 * panel behavior: the draft survives a failed save so no typing is lost.
 */
export function useTextDocument(fs: WorkspaceFs | null, path: string | null): TextDocument {
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(path !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Deferred to a microtask: setState synchronously in an effect body cascades
    // renders (react-hooks/set-state-in-effect).
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      if (path === null) {
        setLoading(false)
        setError(null)
        return
      }
      setLoading(true)
      if (!fs) {
        setError('Open a workspace folder first, then reopen the file.')
        setLoading(false)
        return
      }
      try {
        const content = await fs.readFile(path)
        if (cancelled) return
        setSaved(content)
        setDraft(content)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(describeError(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fs, path])

  const save = useCallback(async () => {
    if (!fs || path === null) return
    setSaving(true)
    try {
      await fs.writeFile(path, draft)
      setSaved(draft)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }, [fs, path, draft])

  const revert = useCallback(() => setDraft(saved), [saved])
  const byteLength = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft])

  return {
    draft,
    saved,
    dirty: draft !== saved,
    loading,
    saving,
    error,
    byteLength,
    setDraft,
    save,
    revert,
  }
}
