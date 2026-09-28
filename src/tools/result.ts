import { ToolRuntimeUnavailableError } from './types'

export type ToolResultCode =
  | 'ok'
  | 'invalid_input'
  | 'path_rejected'
  | 'permission_denied'
  | 'not_found'
  | 'limit_exceeded'
  | 'memory_full'
  | 'no_match'
  | 'multiple_matches'
  | 'stale_write'
  | 'conflict'
  | 'approval_required'
  | 'denied'
  | 'timeout'
  | 'disabled'
  | 'http_error'
  | 'runtime_error'

export interface ToolResult<T = unknown> {
  ok: boolean
  code: ToolResultCode
  value?: T
  message?: string
  hint?: string
  truncated?: boolean
}

export interface ToolResultOptions {
  hint?: string
  value?: unknown
  truncated?: boolean
}

export interface ToolResultContext {
  hint?: string
  value?: unknown
  message?: string
}

export class ToolResultError extends Error {
  readonly code: ToolResultCode
  readonly hint?: string
  readonly value?: unknown

  constructor(code: ToolResultCode, message: string, options: ToolResultOptions & { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolResultError'
    this.code = code
    this.hint = options.hint
    this.value = options.value
  }
}

export function toolOk<T>(value: T, options: { truncated?: boolean } = {}): ToolResult<T> {
  return {
    ok: true,
    code: 'ok',
    value,
    ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
  }
}

export function toolFail(
  code: ToolResultCode,
  message: string,
  options: ToolResultOptions = {},
): ToolResult {
  return {
    ok: false,
    code,
    message,
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
  }
}

const CODE_BY_ERROR_NAME: Record<string, ToolResultCode> = {
  WorkspacePathError: 'path_rejected',
  WorkspacePermissionError: 'permission_denied',
  WorkspaceNotFoundError: 'not_found',
  WorkspaceLimitError: 'limit_exceeded',
  WorkspaceConflictError: 'conflict',
  WorkspaceInvalidInputError: 'invalid_input',
  HttpToolError: 'http_error',
  ToolSchemaError: 'invalid_input',
  SandboxTimeoutError: 'timeout',
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

function nameOf(error: unknown): string {
  if (error instanceof Error) return error.name
  return ''
}

export function toToolResult(error: unknown, context: ToolResultContext = {}): ToolResult {
  if (error instanceof ToolRuntimeUnavailableError) throw error

  const message = context.message ?? messageOf(error)

  if (error instanceof ToolResultError) {
    const value = context.value === undefined ? error.value : context.value
    const hint = context.hint === undefined ? error.hint : context.hint
    return toolFail(error.code, message, {
      ...(value === undefined ? {} : { value }),
      ...(hint === undefined ? {} : { hint }),
    })
  }

  const code = CODE_BY_ERROR_NAME[nameOf(error)] ?? 'runtime_error'
  return toolFail(code, message, {
    ...(context.value === undefined ? {} : { value: context.value }),
    ...(context.hint === undefined ? {} : { hint: context.hint }),
  })
}

export function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; code?: unknown }
  return typeof candidate.ok === 'boolean' && typeof candidate.code === 'string'
}

export function wrapToolExecute<Args extends unknown[], Output>(
  execute: (...args: Args) => Promise<Output | ToolResult>,
): (...args: Args) => Promise<ToolResult<Output>> {
  return async (...args: Args): Promise<ToolResult<Output>> => {
    try {
      const value = await execute(...args)
      return isToolResult(value) ? (value as ToolResult<Output>) : toolOk(value as Output)
    } catch (error) {
      return toToolResult(error) as ToolResult<Output>
    }
  }
}
