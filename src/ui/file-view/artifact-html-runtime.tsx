import { useEffect, useState } from 'react'
import { ViewerLoading } from './feedback'
import {
  ARTIFACT_PREVIEW_SANDBOX,
  externalizeInlineScripts,
  revokeAll,
} from './artifact-html-transform'

/**
 * Renders model-presented HTML in an opaque-origin frame. The HTML and any
 * externalized scripts are served from blob URLs so the frame's scripts run
 * under `script-src 'self' blob:` while the absence of `allow-same-origin` keeps
 * the document from reaching app storage or the parent DOM.
 *
 * The document is served from a blob URL, so it has no workspace base path:
 * artifacts must be self-contained (no relative assets, remote scripts, inline
 * event handlers, or `javascript:` URLs). See `artifact-html-transform.ts`.
 */
export function ArtifactHtmlRuntime({ html }: { html: string }) {
  const [documentUrl, setDocumentUrl] = useState<string | null>(null)

  useEffect(() => {
    const { html: transformed, urls } = externalizeInlineScripts(html)
    const objectUrl = URL.createObjectURL(new Blob([transformed], { type: 'text/html' }))
    let cancelled = false
    // Deferred to a microtask: setState synchronously in an effect body cascades
    // renders (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      if (!cancelled) setDocumentUrl(objectUrl)
    })
    return () => {
      cancelled = true
      URL.revokeObjectURL(objectUrl)
      revokeAll(urls)
    }
  }, [html])

  if (documentUrl === null) return <ViewerLoading label="Loading artifact…" />

  return (
    <iframe
      title="Artifact preview"
      src={documentUrl}
      sandbox={ARTIFACT_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  )
}
