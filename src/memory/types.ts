export const MEMORY_TITLE_MAX = 120
export const MEMORY_BODY_MAX = 2_000
export const MEMORY_MAX_COUNT = 500
export const MEMORY_IMPORTANT_BUDGET = 2_000
export const MEMORY_INDEX_MAX = 100
export const MEMORY_RECALL_MAX = 20

export type MemoryScopeKind = 'global' | 'workspace'

export type MemoryScope =
  | { kind: 'global' }
  | { kind: 'workspace'; scopeId: string; label: string }

export type MemorySource = 'model' | 'user'

export interface Memory {
  id: string
  title: string
  body: string
  scope: MemoryScope
  important: boolean
  source: MemorySource
  threadId?: string
  createdAt: number
  updatedAt: number
}

export interface MemoryDraft {
  title: string
  body: string
  important?: boolean
  scope: MemoryScopeKind
}

export type MemoryErrorCode = 'memory_full' | 'conflict' | 'not_found' | 'invalid_input'

export class MemoryError extends Error {
  readonly code: MemoryErrorCode

  constructor(code: MemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MemoryError'
    this.code = code
  }
}

export class MemoryLimitError extends MemoryError {
  readonly limit: 'important' | 'count'

  constructor(limit: 'important' | 'count', message: string, options?: ErrorOptions) {
    super('memory_full', message, options)
    this.name = 'MemoryLimitError'
    this.limit = limit
  }
}

export class MemoryConflictError extends MemoryError {
  readonly existingId: string

  constructor(existingId: string, message: string, options?: ErrorOptions) {
    super('conflict', message, options)
    this.name = 'MemoryConflictError'
    this.existingId = existingId
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(id: string, options?: ErrorOptions) {
    super('not_found', `No memory with id "${id}" is visible here.`, options)
    this.name = 'MemoryNotFoundError'
  }
}

export class MemoryScopeError extends MemoryError {
  constructor(
    message = 'No workspace folder is granted, so a workspace memory has no folder to belong to.',
    options?: ErrorOptions,
  ) {
    super('invalid_input', message, options)
    this.name = 'MemoryScopeError'
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string, options?: ErrorOptions) {
    super('invalid_input', message, options)
    this.name = 'MemoryValidationError'
  }
}

export class MemoryParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MemoryParseError'
  }
}

export function isMemory(value: unknown): value is Memory {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false
  if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') return false
  if (typeof candidate.important !== 'boolean') return false
  if (candidate.source !== 'model' && candidate.source !== 'user') return false
  if (candidate.threadId !== undefined && typeof candidate.threadId !== 'string') return false
  if (typeof candidate.createdAt !== 'number' || typeof candidate.updatedAt !== 'number') return false
  const scope = candidate.scope as Record<string, unknown> | null | undefined
  if (typeof scope !== 'object' || scope === null) return false
  if (scope.kind === 'global') return true
  return (
    scope.kind === 'workspace' &&
    typeof scope.scopeId === 'string' &&
    scope.scopeId.length > 0 &&
    typeof scope.label === 'string'
  )
}
