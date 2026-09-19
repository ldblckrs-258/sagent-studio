import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelDiscoveryError,
  candidateModelUrls,
  extractModelIds,
  fetchModels,
  mergeModels,
} from './model-catalog'
import type { ProviderConfig } from '../vault/settings'

const SECRET = 'SEEDED_PLAINTEXT_SECRET_1234567890'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'local',
    label: 'Local',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKey: SECRET,
    models: [],
    defaultModel: '',
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('candidateModelUrls', () => {
  it('appends /models to a versioned base URL', () => {
    expect(candidateModelUrls('https://api.example.com/v1')).toEqual([
      'https://api.example.com/v1/models',
    ])
  })

  it('retries the versioned path when the base URL omits the version', () => {
    expect(candidateModelUrls('https://api.example.com')).toEqual([
      'https://api.example.com/models',
      'https://api.example.com/v1/models',
    ])
  })

  it('normalizes trailing slashes', () => {
    expect(candidateModelUrls('https://api.example.com/v1/')).toEqual([
      'https://api.example.com/v1/models',
    ])
  })

  it('returns nothing for a non-http URL', () => {
    expect(candidateModelUrls('ftp://example.com')).toEqual([])
    expect(candidateModelUrls('')).toEqual([])
  })
})

describe('extractModelIds', () => {
  it('reads the OpenAI data shape', () => {
    expect(extractModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ])
  })

  it('reads the Ollama models/name shape', () => {
    expect(extractModelIds({ models: [{ name: 'llama3:8b' }, { name: 'qwen3:32b' }] })).toEqual([
      'llama3:8b',
      'qwen3:32b',
    ])
  })

  it('reads a bare array of strings', () => {
    expect(extractModelIds(['b', 'a'])).toEqual(['a', 'b'])
  })

  it('deduplicates and sorts', () => {
    expect(extractModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
  })

  it('ignores entries without a usable identifier', () => {
    expect(extractModelIds({ data: [{ id: '   ' }, { object: 'model' }, null, 7] })).toEqual([])
    expect(extractModelIds({})).toEqual([])
    expect(extractModelIds(null)).toEqual([])
  })
})

describe('mergeModels', () => {
  it('adds only new ids and reports the count', () => {
    expect(mergeModels(['a'], ['a', 'b', 'c'])).toEqual({ models: ['a', 'b', 'c'], added: 2, truncated: 0 })
  })

  it('enforces the model cap and reports how many were skipped', () => {
    const current = Array.from({ length: 49 }, (_, i) => `m-${i}`)
    const result = mergeModels(current, ['new-1', 'new-2', 'new-3'])
    expect(result.models).toHaveLength(50)
    expect(result.added).toBe(1)
    expect(result.truncated).toBe(2)
  })

  it('does not mutate the input array', () => {
    const current = ['a']
    mergeModels(current, ['b'])
    expect(current).toEqual(['a'])
  })
})

describe('fetchModels', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends the key as a bearer token and returns ids', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), auth: headers.get('authorization') })
      return jsonResponse({ data: [{ id: 'qwen3-32b' }] })
    }) as typeof fetch

    await expect(fetchModels(provider())).resolves.toEqual(['qwen3-32b'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:11434/v1/models')
    expect(calls[0].auth).toBe(`Bearer ${SECRET}`)
  })

  it('falls back to the versioned path when the first candidate 404s', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (urls.length === 1) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse({ data: [{ id: 'llama3' }] })
    }) as typeof fetch

    const ids = await fetchModels(provider({ baseURL: 'https://api.example.com' }))
    expect(ids).toEqual(['llama3'])
    expect(urls).toEqual([
      'https://api.example.com/models',
      'https://api.example.com/v1/models',
    ])
  })

  it('maps an auth failure to an actionable message', async () => {
    globalThis.fetch = (async () => jsonResponse({}, 401)) as typeof fetch
    await expect(fetchModels(provider({ baseURL: 'https://api.example.com/v1' }))).rejects.toThrow(
      /rejected the API key/,
    )
  })

  it('never leaks the api key in an error message', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED while using ${SECRET}`)
    }) as typeof fetch

    await expect(fetchModels(provider())).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ModelDiscoveryError)
      expect((error as Error).message).not.toContain(SECRET)
      return true
    })
  })

  it('reports a non-JSON response as not OpenAI-compatible', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>hello</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch
    await expect(fetchModels(provider({ baseURL: 'https://api.example.com/v1' }))).rejects.toThrow(
      /not JSON/,
    )
  })

  it('rejects an invalid base URL before fetching', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(fetchModels(provider({ baseURL: 'not-a-url' }))).rejects.toThrow(
      ModelDiscoveryError,
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports an empty model list rather than an empty success', async () => {
    globalThis.fetch = (async () => jsonResponse({ data: [] })) as typeof fetch
    await expect(fetchModels(provider())).rejects.toThrow(/no models/)
  })

  it('honors an already-aborted signal as a timeout', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as typeof fetch

    vi.useFakeTimers()
    try {
      const pending = fetchModels(provider())
      const assertion = expect(pending).rejects.toThrow(/did not respond/)
      await vi.advanceTimersByTimeAsync(12_500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
