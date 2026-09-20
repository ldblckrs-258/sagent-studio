export { ARTIFACT_PREVIEW_SANDBOX } from './sandbox'

/** Script `type` values that execute when the element is a classic or module script. */
const EXECUTABLE_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module'])

/**
 * Rewrites inline `<script>` elements to external blob scripts so the artifact
 * document can run them under a strict `script-src 'self' blob:` policy without
 * ever adding `'unsafe-inline'`. `<script src>`, data blocks such as
 * `type="application/json"`, and empty scripts are left untouched; execution
 * order is preserved because each element is replaced in document order.
 *
 * Only `<script>` elements are rewritten. Because the artifact runs with no
 * `'unsafe-inline'`, inline event handlers (`onclick`) and `javascript:` URLs
 * stay blocked, and remote or relative `<script src>`/asset URLs are not
 * available. Artifacts must be self-contained; this is a deliberate limit.
 */
export function externalizeInlineScripts(html: string): { html: string; urls: string[] } {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const urls: string[] = []
  for (const script of Array.from(document.querySelectorAll('script'))) {
    if (script.getAttribute('src') !== null) continue
    const type = (script.getAttribute('type') ?? '').toLowerCase()
    if (!EXECUTABLE_SCRIPT_TYPES.has(type)) continue
    const source = script.textContent ?? ''
    if (source.trim() === '') continue
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    urls.push(url)
    const replacement = document.createElement('script')
    replacement.setAttribute('src', url)
    if (type === 'module') replacement.setAttribute('type', 'module')
    script.replaceWith(replacement)
  }
  return { html: document.documentElement.outerHTML, urls }
}

/** Revokes every blob URL a transform created. */
export function revokeAll(urls: readonly string[]): void {
  for (const url of urls) URL.revokeObjectURL(url)
}
