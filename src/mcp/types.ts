export const MCP_MAX_SERVERS = 20
export const MCP_NAME_MAX = 40
export const MCP_SLUG_MAX = 16
export const MCP_DEFAULT_TIMEOUT_MS = 60_000
export const MCP_MIN_TIMEOUT_MS = 1_000
export const MCP_MAX_TIMEOUT_MS = 300_000

export type McpTransportKind = 'auto' | 'streamable-http' | 'sse'

export const MCP_TRANSPORT_KINDS: readonly McpTransportKind[] = ['auto', 'streamable-http', 'sse']

export type McpAuth =
  | { kind: 'none' }
  | { kind: 'headers'; headers: Record<string, string> }
  | { kind: 'oauth'; clientId?: string; clientSecret?: string; scopes?: string }

export interface McpServerConfig {
  id: string
  name: string
  url: string
  transport: McpTransportKind
  proxyUrl?: string
  auth: McpAuth
  enabled: boolean
  disabledTools: string[]
  timeoutMs: number
}

export interface McpOAuthState {
  clientInformation?: unknown
  tokens?: unknown
  codeVerifier?: string
  discoveryState?: unknown
}

export interface McpServerEntry {
  config: McpServerConfig
  oauth: McpOAuthState
}

export class McpConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpConfigError'
  }
}

export class McpParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpParseError'
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_HEADERS = new Set(['mcp-session-id', 'mcp-protocol-version'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

export function serverSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, MCP_SLUG_MAX)
    .replace(/_$/, '')
}

export function assertAllowedUrl(raw: string, label: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new McpConfigError(`${label} must be an absolute URL.`, { cause })
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return
  throw new McpConfigError(
    `${label} must use https, or http only for localhost and 127.0.0.1. The browser blocks other plain http connections.`,
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new McpConfigError(`${label} must be a string.`)
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function validateHeaders(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new McpConfigError('Headers must be an object.')
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(name)) throw new McpConfigError(`The header name "${name}" is not allowed.`)
    if (!HEADER_NAME.test(name)) throw new McpConfigError(`"${name}" is not a valid header name.`)
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new McpConfigError(`The header "${name}" is set by the transport and cannot be configured.`)
    }
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new McpConfigError(`The header "${name}" needs a single-line string value.`)
    }
    headers[name] = headerValue
  }
  return headers
}

function validateAuth(value: unknown): McpAuth {
  if (!isPlainRecord(value)) throw new McpConfigError('Auth must be an object.')
  if (value.kind === 'none') return { kind: 'none' }
  if (value.kind === 'headers') return { kind: 'headers', headers: validateHeaders(value.headers) }
  if (value.kind === 'oauth') {
    const clientId = optionalString(value.clientId, 'The OAuth client ID')
    const clientSecret = optionalString(value.clientSecret, 'The OAuth client secret')
    const scopes = optionalString(value.scopes, 'The OAuth scopes')
    if (clientSecret !== undefined && clientId === undefined) {
      throw new McpConfigError('An OAuth client secret needs a client ID.')
    }
    return {
      kind: 'oauth',
      ...(clientId !== undefined ? { clientId } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
    }
  }
  throw new McpConfigError('Auth kind must be none, headers, or oauth.')
}

export function validateMcpServerConfig(value: unknown): McpServerConfig {
  if (!isPlainRecord(value)) throw new McpConfigError('The server configuration must be an object.')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) {
    throw new McpConfigError('The server id is invalid.')
  }
  if (typeof value.name !== 'string') throw new McpConfigError('The server needs a name.')
  const name = value.name.trim()
  if (name.length === 0 || name.length > MCP_NAME_MAX) {
    throw new McpConfigError(`The server name must be 1–${MCP_NAME_MAX} characters.`)
  }
  if (serverSlug(name).length === 0) {
    throw new McpConfigError('The server name needs at least one letter or digit.')
  }
  if (typeof value.url !== 'string') throw new McpConfigError('The server needs a URL.')
  const url = value.url.trim()
  assertAllowedUrl(url, 'The server URL')
  const proxyUrl = optionalString(value.proxyUrl, 'The proxy URL')
  if (proxyUrl !== undefined) {
    assertAllowedUrl(proxyUrl, 'The proxy URL')
    if (!/[/=?]$/.test(proxyUrl)) {
      throw new McpConfigError(
        'The proxy URL must end with "/", "?", or "=", because the server URL is appended to it.',
      )
    }
  }
  const transport = value.transport ?? 'auto'
  if (!MCP_TRANSPORT_KINDS.includes(transport as McpTransportKind)) {
    throw new McpConfigError('The transport must be auto, streamable-http, or sse.')
  }
  if (typeof value.enabled !== 'boolean') throw new McpConfigError('The enabled flag must be a boolean.')
  const disabledTools = value.disabledTools ?? []
  if (!Array.isArray(disabledTools) || disabledTools.some((tool) => typeof tool !== 'string')) {
    throw new McpConfigError('Disabled tools must be a list of names.')
  }
  const timeoutMs = value.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MCP_MIN_TIMEOUT_MS ||
    timeoutMs > MCP_MAX_TIMEOUT_MS
  ) {
    throw new McpConfigError(
      `The timeout must be a whole number of milliseconds between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`,
    )
  }
  return {
    id: value.id,
    name,
    url,
    transport: transport as McpTransportKind,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    auth: validateAuth(value.auth ?? { kind: 'none' }),
    enabled: value.enabled,
    disabledTools: [...new Set(disabledTools as string[])],
    timeoutMs,
  }
}

export function assertUniqueServers(configs: readonly McpServerConfig[]): void {
  if (configs.length > MCP_MAX_SERVERS) {
    throw new McpConfigError(`At most ${MCP_MAX_SERVERS} MCP servers can be configured.`)
  }
  const slugs = new Map<string, string>()
  for (const config of configs) {
    const slug = serverSlug(config.name)
    const owner = slugs.get(slug)
    if (owner !== undefined && owner !== config.id) {
      throw new McpConfigError(
        `The name "${config.name}" collides with another server's tool prefix "${slug}". Choose a different name.`,
      )
    }
    slugs.set(slug, config.id)
  }
}

export function newMcpServerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `mcp_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
