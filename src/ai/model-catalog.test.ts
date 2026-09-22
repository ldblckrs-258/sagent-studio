import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelDiscoveryError,
  candidateModelUrls,
  extractModelIds,
  extractModels,
  fetchModels,
  mergeModels,
} from './model-catalog'
import { MAX_MODELS_PER_PROVIDER } from './providers'
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

describe('extractModels', () => {
  it('reads ids, display names, and caps from a gateway listing', () => {
    const payload = {
      models: [
        {
          provider: 'alicode-intl',
          model: 'qwen3.5-plus',
          name: 'Qwen3.5 Plus',
          fullModel: 'alicode-intl/qwen3.5-plus',
          routedModel: 'alicode-intl/qwen3.5-plus',
          alias: 'qwen3.5-plus',
          caps: {
            vision: true,
            search: false,
            reasoning: true,
            contextWindow: 1_000_000,
            maxOutput: 65_536,
          },
        },
      ],
    }
    expect(extractModels(payload)).toEqual([
      {
        id: 'qwen3.5-plus',
        name: 'Qwen3.5 Plus',
        caps: {
          vision: true,
          search: false,
          reasoning: true,
          contextWindow: 1_000_000,
          maxOutput: 65_536,
        },
      },
    ])
  })

  it('reads OpenRouter-style architecture and top_provider caps', () => {
    const [model] = extractModels({
      data: [
        {
          id: 'cmc/deepseek/deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          context_length: 128_000,
          architecture: { input_modalities: ['text', 'image'] },
          top_provider: { context_length: 128_000, max_completion_tokens: 8192 },
          supported_parameters: ['tools', 'reasoning'],
        },
      ],
    })
    expect(model).toEqual({
      id: 'cmc/deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      caps: { vision: true, reasoning: true, contextWindow: 128_000, maxOutput: 8192 },
    })
  })

  it('coerces numeric strings and reads a capabilities block', () => {
    const [model] = extractModels({
      models: [{ id: 'm', capabilities: { vision: 'false', context_window: '200000' } }],
    })
    expect(model).toEqual({ id: 'm', caps: { vision: false, contextWindow: 200_000 } })
  })

  it('treats a text-only modality as no vision', () => {
    const [model] = extractModels({
      data: [{ id: 't', architecture: { modality: 'text->text' } }],
    })
    expect(model?.caps?.vision).toBe(false)
  })

  it('reads an embedding model from model_type, endpoints, and size aliases', () => {
    const [model] = extractModels({
      data: [
        {
          created: 1757680563,
          id: 'qwen/qwen3-embedding-0.6b',
          object: 'model',
          owned_by: 'novita',
          permission: null,
          root: '',
          parent: '',
          input_token_price_per_m: 700,
          output_token_price_per_m: 0,
          pricing: {
            prompt: {
              origin_price_per_m: 700,
              price_per_m: 700,
              origin_price_per_m_decimal: '0.07',
              price_per_m_decimal: '0.07',
            },
          },
          is_tiered_billing: false,
          title: 'qwen/qwen3-embedding-0.6b',
          description: '',
          tags: [],
          context_size: 32768,
          status: 1,
          display_name: 'qwen/qwen3-embedding-0.6b',
          model_type: 'embedding',
          max_output_tokens: 32768,
          features: ['serverless'],
          endpoints: ['embeddings'],
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
      ],
    })
    expect(model).toEqual({
      id: 'qwen/qwen3-embedding-0.6b',
      caps: { embedding: true, vision: false, contextWindow: 32768, maxOutput: 32768 },
    })
  })

  it('reads flat capability aliases and ignores a label that equals the id', () => {
    const [model] = extractModels({
      data: [{ id: 'llama3:8b', name: 'llama3:8b', context_window: 8192 }],
    })
    expect(model).toEqual({ id: 'llama3:8b', caps: { contextWindow: 8192 } })
  })
})

describe('mergeModels', () => {
  it('adds only new ids and reports the count', () => {
    expect(mergeModels([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual({
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      added: 2,
      truncated: 0,
    })
  })

  it('enforces the model cap and reports how many were skipped', () => {
    const current = Array.from({ length: MAX_MODELS_PER_PROVIDER - 1 }, (_, i) => ({ id: `m-${i}` }))
    const result = mergeModels(current, [{ id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }])
    expect(result.models).toHaveLength(MAX_MODELS_PER_PROVIDER)
    expect(result.added).toBe(1)
    expect(result.truncated).toBe(2)
  })

  it('keeps user caps and fills only the gaps on re-fetch', () => {
    const current = [{ id: 'a', caps: { contextWindow: 100 } }]
    const result = mergeModels(current, [
      { id: 'a', name: 'Alpha', caps: { contextWindow: 999, vision: false } },
    ])
    expect(result.models[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      caps: { contextWindow: 100 },
    })
  })

  it('does not mutate the input array', () => {
    const current = [{ id: 'a' }]
    mergeModels(current, [{ id: 'b' }])
    expect(current).toEqual([{ id: 'a' }])
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

    await expect(fetchModels(provider())).resolves.toEqual([{ id: 'qwen3-32b' }])
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
    expect(ids).toEqual([{ id: 'llama3' }])
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
