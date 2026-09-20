import type { WorkspaceSearchHit, WorkspaceSearchResult, WorkspaceSearchSkip } from '../tools/types'
import type { SearchRequest } from './search-protocol'
import { SearchRequestError } from './search-protocol'

export const MAX_HIT_CHARS = 400
export const DEFAULT_MAX_SEARCH_RESULTS = 100
export const MAX_SEARCH_RESULTS = 500
export const DEFAULT_MAX_FILES_SCANNED = 2000
export const DEFAULT_MAX_DEPTH = 20
export const BINARY_PROBE_CHARS = 8 * 1024
/** Bound on recorded skip reasons; `filesSkipped` still reports the full count. */
export const MAX_SKIP_REASONS = 50
/**
 * Vendor/build directories skipped by default so a workspace search reaches
 * source files first. Pass `excludedDirs: []` to scan everything.
 */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]

export function probeBinary(text: string): boolean {
  return text.slice(0, BINARY_PROBE_CHARS).includes('\u0000')
}

export function isCatastrophicPattern(pattern: string): boolean {
  if (/\\[1-9]/.test(pattern)) return true
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return true
  return false
}

export interface ScanHit {
  line: number
  text: string
}

export interface ScanResult {
  hits: ScanHit[]
  truncated: boolean
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export function scanText(text: string, matcher: RegExp, maxResults: number): ScanResult {
  const hits: ScanHit[] = []
  if (text.length === 0) return { hits, truncated: false }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (hits.length >= maxResults) return { hits, truncated: true }
    const line = stripCarriageReturn(lines[index])
    matcher.lastIndex = 0
    if (matcher.test(line)) {
      hits.push({ line: index + 1, text: line.length > MAX_HIT_CHARS ? line.slice(0, MAX_HIT_CHARS) : line })
    }
  }
  return { hits, truncated: false }
}

export type SearchFsCall = (op: 'list' | 'read', path: string) => Promise<string>

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

interface ListEntry {
  path: string
  kind: 'file' | 'directory'
}

function parseEntries(raw: string): ListEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is ListEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        ((entry as { kind?: unknown }).kind === 'file' || (entry as { kind?: unknown }).kind === 'directory'),
    )
  } catch {
    return []
  }
}

export async function runSearch(callFs: SearchFsCall, request: SearchRequest): Promise<WorkspaceSearchResult> {
  if (isCatastrophicPattern(request.pattern)) {
    throw new SearchRequestError(
      'invalid_input',
      'The search pattern can cause catastrophic backtracking.',
      { hint: 'Remove nested quantifiers or backreferences and retry.' },
    )
  }

  let matcher: RegExp
  try {
    matcher = new RegExp(request.pattern, request.flags)
  } catch (cause) {
    throw new SearchRequestError('invalid_input', 'The search pattern is not a valid regular expression.', {
      hint: 'Fix the pattern syntax and retry.',
      cause,
    })
  }

  const hits: WorkspaceSearchHit[] = []
  const skipped: WorkspaceSearchSkip[] = []
  let filesScanned = 0
  let filesSkipped = 0
  let truncated = false

  const recordSkip = (path: string, reason: string): void => {
    filesSkipped += 1
    if (skipped.length < MAX_SKIP_REASONS) skipped.push({ path, reason })
  }

  const queue: Array<{ path: string; depth: number }> = [{ path: request.rootPath, depth: 0 }]
  while (queue.length > 0) {
    if (hits.length >= request.maxResults || filesScanned >= request.maxFilesScanned) {
      truncated = true
      break
    }
    const directory = queue.shift()
    if (!directory) break

    let raw: string
    try {
      raw = await callFs('list', directory.path)
    } catch (error) {
      recordSkip(directory.path, reasonOf(error))
      continue
    }

    for (const entry of parseEntries(raw)) {
      if (hits.length >= request.maxResults || filesScanned >= request.maxFilesScanned) {
        truncated = true
        break
      }
      if (entry.kind === 'directory') {
        const name = entry.path.split('/').pop() ?? entry.path
        if (request.excludedDirs?.includes(name)) continue
        if (directory.depth + 1 <= request.maxDepth) {
          queue.push({ path: entry.path, depth: directory.depth + 1 })
        } else {
          truncated = true
        }
        continue
      }

      filesScanned += 1
      let text: string
      try {
        text = await callFs('read', entry.path)
      } catch (error) {
        recordSkip(entry.path, reasonOf(error))
        continue
      }
      if (probeBinary(text)) {
        recordSkip(entry.path, 'binary content (NUL byte in the first 8KB)')
        continue
      }
      const remaining = request.maxResults - hits.length
      const scan = scanText(text, matcher, remaining)
      for (const hit of scan.hits) hits.push({ path: entry.path, line: hit.line, text: hit.text })
      if (scan.truncated) {
        truncated = true
        break
      }
    }
  }

  return { hits, truncated, filesScanned, filesSkipped, skipped }
}
