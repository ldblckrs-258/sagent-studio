import { toolOk, toToolResult } from './result'
import type { ToolResult } from './result'
import { HttpToolError, ToolSchemaError } from './types'
import type { HttpRequestTemplate } from './types'

export const MAX_RESPONSE_BYTES = 1_000_000
export const DEFAULT_TIMEOUT_MS = 15_000
export const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

const INTERPOLATION = /\{\{\s*input\.([A-Za-z0-9_.]+)\s*\}\}/g
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export interface HttpToolResult {
  status: number
  contentType: string | null
  body: string
}

function readPath(input: unknown, path: string): string {
  let cursor: unknown = input
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      throw new HttpToolError(`The input path "${path}" is missing from the tool arguments.`)
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  if (cursor === undefined) {
    throw new HttpToolError(`The input path "${path}" is missing from the tool arguments.`)
  }
  if (typeof cursor === 'object') {
    throw new HttpToolError(`The input path "${path}" must resolve to a scalar value.`)
  }
  return String(cursor)
}

function interpolate(template: string, input: unknown): string {
  return template.replace(INTERPOLATION, (_match, path: string) => readPath(input, path))
}

function unresolvedPlaceholders(template: string): string[] {
  const found: string[] = []
  for (const match of template.matchAll(ANY_PLACEHOLDER)) {
    if (!/^\s*input\.[A-Za-z0-9_.]+\s*$/.test(match[1] ?? '')) found.push(match[0])
  }
  return found
}

export function assertRequestTemplates(request: HttpRequestTemplate, name: string): void {
  const templates = [
    request.url,
    ...(request.body === undefined ? [] : [request.body]),
    ...Object.values(request.headers ?? {}),
  ]
  for (const template of templates) {
    if (typeof template !== 'string') continue
    const unresolved = unresolvedPlaceholders(template)
    if (unresolved.length > 0) {
      throw new ToolSchemaError(
        `The http tool "${name}" has placeholders that will never interpolate: ${unresolved.join(', ')}. Only {{input.<path>}} is substituted, where <path> names a tool argument.`,
      )
    }
  }
}

function assertStaticAuthority(rawUrl: string): void {
  const schemeEnd = rawUrl.indexOf('://')
  if (schemeEnd <= 0) throw new HttpToolError('The tool URL must be absolute.')
  const scheme = rawUrl.slice(0, schemeEnd)
  if (scheme.includes('{{')) throw new HttpToolError('The URL scheme cannot be templated.')
  const normalized = scheme.toLowerCase()
  if (normalized !== 'http' && normalized !== 'https') {
    throw new HttpToolError(`Unsupported URL scheme "${scheme}".`)
  }
  const afterScheme = rawUrl.slice(schemeEnd + 3)
  const authorityEnd = afterScheme.search(/[/?#]/)
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd)
  if (authority.length === 0) throw new HttpToolError('The tool URL needs a host.')
  if (authority.includes('{{')) throw new HttpToolError('The URL authority cannot be templated.')
}

function normalizeOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>()
  for (const origin of origins) {
    try {
      normalized.add(new URL(origin).origin)
    } catch {
      normalized.add(origin)
    }
  }
  return normalized
}

export function resolveToolUrl(
  template: string,
  input: unknown,
  allowedOrigins: readonly string[],
): URL {
  assertStaticAuthority(template)
  const resolved = interpolate(template, input)
  const unresolved = unresolvedPlaceholders(resolved)
  if (unresolved.length > 0) {
    throw new HttpToolError(
      `The URL still contains uninterpolated placeholders: ${unresolved.join(', ')}. Only {{input.<path>}} is substituted, where <path> names a tool argument.`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(resolved)
  } catch (cause) {
    throw new HttpToolError('The tool URL did not resolve to a valid URL.', { cause })
  }
  if (!normalizeOrigins(allowedOrigins).has(parsed.origin)) {
    throw new HttpToolError(`The resolved origin "${parsed.origin}" is not on the allow-list.`)
  }
  return parsed
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new HttpToolError(`The response exceeded the ${maxBytes}-byte cap.`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export async function executeHttpTool(
  request: HttpRequestTemplate,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult<HttpToolResult>> {
  try {
    const url = resolveToolUrl(request.url, input, request.allowedOrigins)

    const method = (request.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw new HttpToolError(`Unsupported HTTP method "${method}".`)
    }

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.includes('{{')) {
        throw new HttpToolError('Header names cannot be templated.')
      }
      headers[name] = interpolate(value, input)
    }

    const body = request.body === undefined ? undefined : interpolate(request.body, input)
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'TimeoutError') {
        throw new HttpToolError(`The request timed out after ${timeoutMs}ms.`, { cause })
      }
      throw new HttpToolError('The request failed before a response was received.', { cause })
    }

    if (!response.ok) {
      throw new HttpToolError(`The request failed with status ${response.status}.`)
    }

    return toolOk({
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await readCapped(response, MAX_RESPONSE_BYTES),
    })
  } catch (error) {
    return toToolResult(error, {
      hint: 'Call read_tool_guide with topic "custom_tools" for the rules and examples.',
    }) as ToolResult<HttpToolResult>
  }
}
