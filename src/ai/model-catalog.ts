import { MAX_MODELS_PER_PROVIDER } from './providers'
import type { ProviderConfig } from '../vault/settings'

/** Raised when a provider's model list cannot be read. Never includes the API key. */
export class ModelDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelDiscoveryError'
  }
}

const TIMEOUT_MS = 12_000

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeBase(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * Candidate endpoints for an OpenAI-compatible model listing. The path is appended
 * to the configured base URL. When the base URL omits the version segment, the
 * versioned path is retried once, which is the most common configuration mistake.
 */
export function candidateModelUrls(baseURL: string): string[] {
  const base = normalizeBase(baseURL)
  if (!isHttpUrl(base)) return []
  const root = `${base}/models`
  if (/\/v\d+$/i.test(base)) return [root]
  return [root, `${base}/v1/models`]
}

function readId(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  for (const key of ['id', 'name', 'model']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * Reads model identifiers out of the shapes OpenAI-compatible servers actually
 * return: `{ data: [{ id }] }`, `{ models: [{ name }] }` (Ollama native), and a
 * bare array.
 */
export function extractModelIds(payload: unknown): string[] {
  let entries: unknown[] = []
  if (Array.isArray(payload)) {
    entries = payload
  } else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    for (const key of ['data', 'models']) {
      if (Array.isArray(record[key])) {
        entries = record[key] as unknown[]
        break
      }
    }
  }
  const ids = entries.map(readId).filter((id): id is string => id !== null)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

async function requestModels(url: string, provider: ProviderConfig, signal: AbortSignal) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (provider.apiKey.trim()) headers.authorization = `Bearer ${provider.apiKey.trim()}`
  return fetch(url, { headers, signal })
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'The provider rejected the API key for this request.'
  }
  if (status === 404) return 'No model listing exists at this address.'
  if (status === 429) return 'The provider is rate limiting requests. Try again shortly.'
  if (status >= 500) return `The provider returned a server error (${status}).`
  return `The provider returned an unexpected status (${status}).`
}

/**
 * Fetches the model list for a provider. Reads both `id` and `name` shapes and
 * never surfaces the API key in a thrown message.
 */
export async function fetchModels(provider: ProviderConfig): Promise<string[]> {
  const urls = candidateModelUrls(provider.baseURL)
  if (urls.length === 0) {
    throw new ModelDiscoveryError('A valid http(s) base URL is required before discovering models.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let lastError: ModelDiscoveryError | null = null
    for (const url of urls) {
      let response: Response
      try {
        response = await requestModels(url, provider, controller.signal)
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new ModelDiscoveryError('The provider did not respond within 12 seconds.', {
            cause,
          })
        }
        throw new ModelDiscoveryError(
          'The provider could not be reached. Check the base URL and that the server allows browser requests.',
          { cause },
        )
      }

      if (!response.ok) {
        lastError = new ModelDiscoveryError(describeStatus(response.status))
        continue
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (cause) {
        throw new ModelDiscoveryError(
          'The response was not JSON. This address may not be an OpenAI-compatible API.',
          { cause },
        )
      }

      const ids = extractModelIds(payload)
      if (ids.length === 0) {
        throw new ModelDiscoveryError(
          'The provider returned no models. Add model IDs manually below.',
        )
      }
      return ids
    }

    throw lastError ?? new ModelDiscoveryError('No model listing could be read from this provider.')
  } finally {
    clearTimeout(timer)
  }
}

/** Merges discovered ids into the current selection without exceeding the cap. */
export function mergeModels(current: string[], discovered: string[]): {
  models: string[]
  added: number
  truncated: number
} {
  const merged = [...current]
  let added = 0
  let truncated = 0
  for (const id of discovered) {
    if (merged.includes(id)) continue
    if (merged.length >= MAX_MODELS_PER_PROVIDER) {
      truncated += 1
      continue
    }
    merged.push(id)
    added += 1
  }
  return { models: merged, added, truncated }
}
