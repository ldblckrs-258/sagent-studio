import { useCallback, useEffect, useState } from 'react'
import { WorkspaceError } from '../../workspace/errors'
import type { WorkspaceFs } from '../../workspace/fs'
import { readWorkspaceBlob } from '../../workspace/fs'

/** Remote text previews (CSV, HTML source, plain text) stay small. */
export const REMOTE_TEXT_CAP = 5 * 1024 * 1024

/** Remote documents and media share the workspace binary ceiling. */
export const REMOTE_BINARY_CAP = 100 * 1024 * 1024

/** Images and media are streamed through an object URL, so they are not capped. */
export const UNCAPPED = Number.POSITIVE_INFINITY

export interface AsyncResource<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: T | null
  error: string | null
}

export function describeError(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message
  if (error instanceof Error) return error.message
  return 'The file could not be loaded.'
}

function networkMessage(url: string, error: unknown): string {
  const reason = describeError(error)
  return `${reason} The link may be unreachable or may not allow cross-origin fetches (${url}).`
}

export async function fetchLimitedBlob(url: string, maxBytes = REMOTE_BINARY_CAP): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(networkMessage(url, error), { cause: error })
  }
  if (!response.ok) {
    throw new Error(`The link returned ${response.status} ${response.statusText}.`)
  }
  const blob = await response.blob()
  if (blob.size > maxBytes) {
    throw new Error('The linked file is larger than the preview limit.')
  }
  return blob
}

export async function fetchLimitedText(url: string, maxBytes = REMOTE_TEXT_CAP): Promise<string> {
  const blob = await fetchLimitedBlob(url, maxBytes)
  return blob.text()
}

/**
 * Runs an async loader and tracks its lifecycle. Returning `null` from the
 * loader means "not applicable" (for example a remote target that this viewer
 * does not fetch) and parks the resource at `idle`. The loader must be memoized
 * by the caller; it is the effect's only dependency.
 */
export function useAsyncResource<T>(load: () => Promise<T> | null): AsyncResource<T> {
  const [state, setState] = useState<AsyncResource<T>>({
    status: 'loading',
    value: null,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    // Writes are deferred to a microtask: calling setState synchronously in an
    // effect body cascades renders (react-hooks/set-state-in-effect).
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      const result = load()
      if (result === null) {
        setState({ status: 'idle', value: null, error: null })
        return
      }
      setState({ status: 'loading', value: null, error: null })
      try {
        const value = await result
        if (!cancelled) setState({ status: 'ready', value, error: null })
      } catch (error) {
        if (!cancelled) setState({ status: 'error', value: null, error: describeError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  return state
}

/** Creates an object URL for a blob and revokes it when the blob changes. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const next = blob ? URL.createObjectURL(blob) : null
    // Deferred to a microtask for the same reason as `useAsyncResource`.
    void Promise.resolve().then(() => {
      if (!cancelled) setUrl(next)
    })
    return () => {
      cancelled = true
      if (next) URL.revokeObjectURL(next)
    }
  }, [blob])

  return blob ? url : null
}

export function useWorkspaceBlob(
  fs: WorkspaceFs | null,
  path: string | null,
  maxBytes?: number,
): AsyncResource<Blob> {
  const load = useCallback(() => {
    if (!path) return null
    if (!fs) return Promise.reject(new Error('Open a workspace folder first, then reopen the file.'))
    return readWorkspaceBlob(fs, path, maxBytes === undefined ? {} : { maxBytes })
  }, [fs, path, maxBytes])
  return useAsyncResource(load)
}

export function useRemoteBlob(url: string | null): AsyncResource<Blob> {
  const load = useCallback(() => (url ? fetchLimitedBlob(url) : null), [url])
  return useAsyncResource(load)
}

export function useWorkspaceText(fs: WorkspaceFs | null, path: string | null): AsyncResource<string> {
  const load = useCallback(() => {
    if (!path) return null
    if (!fs) return Promise.reject(new Error('Open a workspace folder first, then reopen the file.'))
    return fs.readFile(path)
  }, [fs, path])
  return useAsyncResource(load)
}

export function useRemoteText(url: string | null): AsyncResource<string> {
  const load = useCallback(() => (url ? fetchLimitedText(url) : null), [url])
  return useAsyncResource(load)
}
