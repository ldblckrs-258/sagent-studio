import type { WorkspaceSearchResult } from '../tools/types'

export const SEARCH_TIMEOUT_MS = 5000

export interface SearchRequest {
  pattern: string
  flags: string
  rootPath: string
  maxResults: number
  maxFilesScanned: number
  maxDepth: number
}

export type SearchWorkerRequest = { kind: 'search' } & SearchRequest

export type SearchWorkerOutbound =
  | { kind: 'fs.call'; requestId: string; op: 'list' | 'read'; path: string }
  | { kind: 'search-done'; result: WorkspaceSearchResult }
  | { kind: 'search-error'; code: SearchErrorCode; message: string; hint?: string }

export type SearchMainMessage =
  | { kind: 'fs.result'; requestId: string; ok: true; data: string }
  | { kind: 'fs.error'; requestId: string; ok: false; message: string }

export type SearchErrorCode = 'invalid_input' | 'runtime_error' | 'timeout'

export class SearchRequestError extends Error {
  readonly code: SearchErrorCode
  readonly hint?: string

  constructor(code: SearchErrorCode, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SearchRequestError'
    this.code = code
    this.hint = options.hint
  }
}
