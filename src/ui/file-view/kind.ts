import type { FileTarget } from '../../session/file-view-state'

export type FileKind =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'html'
  | 'csv'
  | 'spreadsheet'
  | 'docx'
  | 'markdown'
  | 'json'
  | 'diagram'
  | 'embed'

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'svg',
])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'])
const HTML_EXTENSIONS = new Set(['html', 'htm'])
const CSV_EXTENSIONS = new Set(['csv', 'tsv'])
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls'])
const DOCX_EXTENSIONS = new Set(['docx'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const JSON_EXTENSIONS = new Set(['json'])
const DIAGRAM_EXTENSIONS = new Set(['mmd', 'mermaid'])

/** Lower-cased extension of a path or URL, ignoring query and fragment. */
export function extensionOf(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0]
  const name = withoutQuery.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function kindForExtension(extension: string): FileKind | null {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (HTML_EXTENSIONS.has(extension)) return 'html'
  if (CSV_EXTENSIONS.has(extension)) return 'csv'
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet'
  if (DOCX_EXTENSIONS.has(extension)) return 'docx'
  // `jsonc` is deliberately absent: `JSON.parse` cannot read its comments or
  // trailing commas, so mapping it here would guarantee a permanent error state.
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (JSON_EXTENSIONS.has(extension)) return 'json'
  if (DIAGRAM_EXTENSIONS.has(extension)) return 'diagram'
  return null
}

/** Unknown workspace files stay editable text rather than becoming unopenable. */
export function kindForPath(path: string): FileKind {
  return kindForExtension(extensionOf(path)) ?? 'text'
}

/** Unknown remote links fall back to the sandboxed embed viewer. */
export function kindForRemote(url: string): FileKind {
  return kindForExtension(extensionOf(url)) ?? 'embed'
}

export function kindForTarget(target: FileTarget): FileKind {
  return target.kind === 'workspace' ? kindForPath(target.path) : kindForRemote(target.url)
}

export function targetTitle(target: FileTarget): string {
  return target.kind === 'workspace' ? target.path : target.url
}

const KIND_LABELS: Record<FileKind, string> = {
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  html: 'HTML',
  csv: 'CSV',
  spreadsheet: 'Sheet',
  docx: 'Document',
  markdown: 'Markdown',
  json: 'JSON',
  diagram: 'Diagram',
  embed: 'Link',
}

export function kindLabel(kind: FileKind): string {
  return KIND_LABELS[kind]
}

/**
 * Accepts what a user pastes into the URL bar: a bare host, an explicit
 * `http(s)://` link, or a protocol-relative `//host/path`. Everything else —
 * including `javascript:` and `data:` — is rejected so a pasted string can never
 * become an executable target.
 */
export function normalizeRemoteInput(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  // A non-http(s) scheme written with `://` is rejected outright rather than
  // being folded into a host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null
  // Only `http(s)://` and protocol-relative input keep their form. Anything
  // else is treated as a bare host, so an explicit foreign scheme such as
  // `javascript:` becomes an unparseable `https://javascript:…` and is rejected.
  let candidate = trimmed
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  else if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  return url.href
}

/** Resolves an already-absolute http(s) href (chat/markdown link) or `null`. */
export function absoluteHttpUrl(href: string | undefined): string | null {
  if (!href) return null
  const candidate = href.startsWith('//') ? `https:${href}` : href
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
