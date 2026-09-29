import { timingSafeEqual } from 'node:crypto'
import { SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX } from './protocol.js'

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin || origin === 'null') return false
  return allowed.has(origin)
}

export function parseSubprotocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return []
  const raw = Array.isArray(header) ? header.join(',') : header
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function tokensEqual(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(token, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function hasValidToken(protocols: readonly string[], token: string): boolean {
  if (!protocols.includes(SUBPROTOCOL)) return false
  const tokens = protocols.filter((p) => p.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
  if (tokens.length !== 1) return false
  return tokensEqual(tokens[0].slice(TOKEN_SUBPROTOCOL_PREFIX.length), token)
}

export type UpgradeVerdict = { ok: true } | { ok: false; status: 401 | 403; reason: string }

export function checkUpgrade(
  headers: { host?: string; origin?: string; protocols?: string | string[] },
  port: number,
  allowedOrigins: ReadonlySet<string>,
  token: string,
): UpgradeVerdict {
  if (!isAllowedHost(headers.host, port)) return { ok: false, status: 403, reason: 'host not allowed' }
  if (!isAllowedOrigin(headers.origin, allowedOrigins)) return { ok: false, status: 403, reason: 'origin not allowed' }
  if (!hasValidToken(parseSubprotocols(headers.protocols), token)) return { ok: false, status: 401, reason: 'bad token' }
  return { ok: true }
}

export function redactToken(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('[redacted]')
}
