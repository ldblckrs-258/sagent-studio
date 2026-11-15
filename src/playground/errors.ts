import { redactSecrets } from '../tools/redact'

export type PlaygroundErrorCode =
  | 'no_token'
  | 'unauthorized'
  | 'payment_required'
  | 'not_found'
  | 'invalid_input'
  | 'rate_limited'
  | 'too_large'
  | 'network'
  | 'prediction_failed'
  | 'canceled'
  | 'unsupported_output'
  | 'storage_full'
  | 'http'

export class PlaygroundError extends Error {
  readonly code: PlaygroundErrorCode
  readonly status?: number

  constructor(code: PlaygroundErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PlaygroundError'
    this.code = code
    if (options?.status !== undefined) this.status = options.status
  }
}

export const MAX_ERROR_MESSAGE = 500

const STATUS_CODES: Record<number, PlaygroundErrorCode> = {
  401: 'unauthorized',
  402: 'payment_required',
  404: 'not_found',
  413: 'too_large',
  422: 'invalid_input',
  429: 'rate_limited',
}

const DEFAULT_MESSAGES: Partial<Record<PlaygroundErrorCode, string>> = {
  unauthorized: 'The provider rejected the token. Check it in Config → Providers.',
  payment_required: 'The provider account has no credit left for this run.',
  not_found: 'The provider could not find that model or prediction.',
  too_large: 'The request was too large for the provider.',
  invalid_input: 'The provider rejected the input for this model.',
  rate_limited: 'The provider is rate limiting requests. Wait a moment and try again.',
}

export type ErrorFallbacks = Partial<Record<PlaygroundErrorCode, string>>

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE - 1)}…` : text
}

function problemText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  for (const key of ['detail', 'title']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

export function fromHttp(status: number, body: unknown, fallbacks: ErrorFallbacks = {}): PlaygroundError {
  const code = STATUS_CODES[status] ?? 'http'
  const message =
    problemText(body) ??
    fallbacks[code] ??
    DEFAULT_MESSAGES[code] ??
    `The provider returned HTTP ${status}.`
  return new PlaygroundError(code, truncate(message), { status })
}

export function redactToken(message: string, token: string): string {
  const exact = token === '' ? message : message.split(token).join('[redacted]')
  return redactSecrets(exact)
}
