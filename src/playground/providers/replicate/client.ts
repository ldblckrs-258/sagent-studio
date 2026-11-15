import { fromHttp, PlaygroundError, redactToken } from '../../errors'
import type { ErrorFallbacks } from '../../errors'

export interface ReplicateHttpConfig {
  apiKey: string
  baseURL: string
  fetch?: typeof fetch
}

export interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  fallbacks?: ErrorFallbacks
}

export interface ReplicateHttp {
  request(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<unknown>
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function createReplicateHttp(config: ReplicateHttpConfig): ReplicateHttp {
  const fetchImpl = config.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const redact = (error: PlaygroundError) =>
    new PlaygroundError(error.code, redactToken(error.message, config.apiKey), { status: error.status })

  return {
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers, Authorization: `Bearer ${config.apiKey}` }
      let body: BodyInit | undefined
      if (options.body instanceof FormData) {
        body = options.body
      } else if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(options.body)
      }
      let response: Response
      try {
        response = await fetchImpl(`${config.baseURL}${path}`, {
          method,
          headers,
          body,
          credentials: 'omit',
          signal: options.signal,
        })
      } catch (error) {
        if (isAbort(error)) throw error
        if (error instanceof TypeError) {
          throw new PlaygroundError(
            'network',
            `The browser could not reach Replicate through ${config.baseURL}. Check the base URL in Config → Providers, or the host's proxy for that path.`,
            { cause: error },
          )
        }
        throw error
      }
      const text = await response.text().catch(() => '')
      let parsed: unknown
      try {
        parsed = text === '' ? null : (JSON.parse(text) as unknown)
      } catch {
        parsed = null
      }
      if (!response.ok) throw redact(fromHttp(response.status, parsed, options.fallbacks))
      return parsed
    },
  }
}
