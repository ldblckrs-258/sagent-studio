import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { McpOAuthRedirectRequired } from './oauth-provider'
import type { McpAuth } from './types'

export const MCP_REASON_MAX = 500

export type McpErrorKind = 'network_or_cors' | 'unauthorized' | 'timeout' | 'closed' | 'protocol'

export interface McpFailure {
  state: 'needs-auth' | 'error'
  kind: McpErrorKind
  reason: string
}

export const NETWORK_OR_CORS_REASON =
  'The browser could not reach the server. It may be down, or it may not allow cross-origin requests from this app; set a proxy URL for this server.'

export function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError || error instanceof SseError) return error.code
  return undefined
}

function truncate(text: string): string {
  return text.length > MCP_REASON_MAX ? `${text.slice(0, MCP_REASON_MAX - 1)}…` : text
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return String(error)
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof SseError && error.code === undefined) return true
  return false
}

export function describeMcpError(error: unknown): string {
  if (isNetworkFailure(error)) return NETWORK_OR_CORS_REASON
  return truncate(messageOf(error))
}

export function classifyMcpError(error: unknown, auth: McpAuth): McpFailure {
  const status = httpStatusOf(error)
  if (error instanceof McpOAuthRedirectRequired) {
    return { state: 'needs-auth', kind: 'unauthorized', reason: 'Sign in to this server to continue.' }
  }
  if (error instanceof OAuthError && auth.kind === 'oauth') {
    return {
      state: 'needs-auth',
      kind: 'unauthorized',
      reason: `Sign in again: ${truncate(messageOf(error))}`,
    }
  }
  if (error instanceof UnauthorizedError || status === 401) {
    if (auth.kind === 'oauth') {
      return { state: 'needs-auth', kind: 'unauthorized', reason: 'Sign in to this server to continue.' }
    }
    return {
      state: 'error',
      kind: 'unauthorized',
      reason:
        auth.kind === 'headers'
          ? 'The server rejected the configured headers (401). Check the credentials, or switch this server to OAuth.'
          : 'The server requires authentication (401). Configure headers or OAuth for this server.',
    }
  }
  if (status === 403) {
    return {
      state: 'error',
      kind: 'unauthorized',
      reason: 'The server refused access (403). The credentials lack the needed permission.',
    }
  }
  if (isNetworkFailure(error)) {
    return { state: 'error', kind: 'network_or_cors', reason: NETWORK_OR_CORS_REASON }
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return { state: 'error', kind: 'timeout', reason: truncate(messageOf(error)) }
  }
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
    return { state: 'error', kind: 'closed', reason: 'The connection to the server closed.' }
  }
  return { state: 'error', kind: 'protocol', reason: truncate(messageOf(error)) }
}

export class McpNotReadyError extends Error {
  constructor(serverName: string, options?: ErrorOptions) {
    super(`The MCP server "${serverName}" is not connected.`, options)
    this.name = 'McpNotReadyError'
  }
}

export class McpSessionClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super('MCP connections are closed because the vault locked.', options)
    this.name = 'McpSessionClosedError'
  }
}
