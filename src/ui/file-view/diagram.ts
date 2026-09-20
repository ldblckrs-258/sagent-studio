let renderer: Promise<typeof import('mermaid')> | null = null

/**
 * Loads and initializes Mermaid once per session. `securityLevel: 'strict'`
 * governs how labels are escaped, and initializing once keeps a user tool or a
 * second viewer from resetting the security level mid-session. The dynamic
 * import keeps Mermaid out of the entry chunk.
 */
export function loadMermaid(): Promise<typeof import('mermaid')> {
  renderer ??= import('mermaid').then((module) => {
    module.default.initialize({ startOnLoad: false, securityLevel: 'strict' })
    return module
  })
  return renderer
}

/**
 * Sanitizes Mermaid's returned SVG before it is injected into the app document.
 * This is an independent second layer behind `securityLevel: 'strict'`. DOMPurify
 * is imported lazily so it, like Mermaid, stays out of the entry chunk.
 */
export async function sanitizeDiagramSvg(svg: string): Promise<string> {
  const { default: DOMPurify } = await import('dompurify')
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
}
