/**
 * Redaction for display. Tool inputs can carry credentials (an HTTP tool's
 * `Authorization` header is the common case), so every value rendered in an
 * approval card or a transcript passes through here before it reaches the DOM.
 */

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]+/gi,
]

export function redactSecrets(text: string): string {
  let output = text
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]')
  return output
}

/** Keys whose values are never shown; compared without separators or case. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'token',
  'secret',
  'password',
  'cookie',
])

const MAX_DEPTH = 12
const UNSERIALIZABLE = '[unserializable]'

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  // A match anywhere catches prefixed headers like `X-Api-Key` and
  // `access_token`; over-redacting a display value is the safe direction.
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalized.includes(sensitive)) return true
  }
  return false
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function scrub(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') {
    // Functions, symbols, and bigints are not displayable data.
    return typeof value === 'function' ? UNSERIALIZABLE : value
  }
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((entry) => scrub(entry, seen, depth + 1))
  if (!isPlainObject(value)) return UNSERIALIZABLE

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? '[redacted]' : scrub(entry, seen, depth + 1)
  }
  return output
}

/**
 * Deep-clones plain data, replacing values under sensitive keys and scrubbing
 * secret-looking strings. A function, class instance, or cycle becomes a safe
 * placeholder rather than throwing.
 */
export function redactForDisplay(value: unknown): unknown {
  return scrub(value, new WeakSet(), 0)
}
