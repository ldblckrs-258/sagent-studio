import { describe, expect, it } from 'vitest'
import { APICallError } from 'ai'
import { MockEmbeddingModelV4 } from 'ai/test'
import {
  createEmbedder,
  embedPassages,
  embedTokenBudget,
  EmbeddingInputError,
  EmbeddingProbeError,
  DEFAULT_MAX_EMBED_REQUEST_TOKENS,
  MAX_EMBED_INPUT_TOKENS,
  parseRateLimitDelayMs,
  probeEmbedding,
  rateLimitDelayMs,
} from './embedder'
import { LLMConfigError } from './providers'
import { defaultSettings } from '../vault/settings'
import type { ProviderConfig, Settings } from '../vault/settings'

function provider(id: string): ProviderConfig {
  return {
    id,
    label: id,
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'test-key',
    models: [{ id: 'llama3' }],
    defaultModel: 'llama3',
  }
}

function settingsWith(overrides: Partial<Settings['rag']> = {}, providers = [provider('p1'), provider('p2')]): Settings {
  return {
    ...defaultSettings(),
    providers,
    rag: { ...defaultSettings().rag, ...overrides },
  }
}

function embeddingModel(embeddings: number[][]): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'test-embed',
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((_, index) => embeddings[index] ?? embeddings[0] ?? [0, 0]),
      usage: { tokens: values.length * 2 },
      warnings: [],
    }),
  })
}

function providerOf(model: unknown): string {
  return (model as { provider?: string }).provider ?? ''
}

describe('createEmbedder', () => {
  it('resolves the explicitly picked provider', () => {
    expect(providerOf(createEmbedder(settingsWith(), 'p2'))).toMatch(/^p2/)
  })

  it('falls back to rag.embedProviderId only when no pick is passed', () => {
    expect(providerOf(createEmbedder(settingsWith({ embedProviderId: 'p2' })))).toMatch(/^p2/)
  })

  it('seeds from the first configured provider when nothing is picked', () => {
    expect(providerOf(createEmbedder(settingsWith()))).toMatch(/^p1/)
  })

  it('throws LLMConfigError for a blank embed model', () => {
    expect(() => createEmbedder(settingsWith({ embedModel: '   ' }), 'p1')).toThrow(LLMConfigError)
  })

  it('throws LLMConfigError when no provider is configured', () => {
    expect(() => createEmbedder(settingsWith({}, []))).toThrow(LLMConfigError)
  })
})

describe('embedPassages', () => {
  it('returns vectors in input order with tokens-only usage', async () => {
    const model = embeddingModel([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    const result = await embedPassages(model, ['a', 'b', 'c'])
    expect(result.embeddings).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    expect(result.usage).toEqual({ tokens: 6 })
    expect(result.usage).not.toHaveProperty('dimensions')
  })

  it('returns no vectors for an empty input without calling the model', async () => {
    const model = embeddingModel([[1, 2]])
    await expect(embedPassages(model, [])).resolves.toEqual({ embeddings: [], usage: { tokens: 0 } })
    expect(model.doEmbedCalls).toHaveLength(0)
  })

  it('rejects an unchunked passage and an empty passage before calling the model', async () => {
    const model = embeddingModel([[1, 2]])
    const huge = Array.from({ length: MAX_EMBED_INPUT_TOKENS + 50 }, (_, i) => `word${i}`).join(' ')
    await expect(embedPassages(model, [huge])).rejects.toBeInstanceOf(EmbeddingInputError)
    await expect(embedPassages(model, ['   '])).rejects.toBeInstanceOf(EmbeddingInputError)
    expect(model.doEmbedCalls).toHaveLength(0)
  })

  it('splits the input into budgeted requests and preserves input order', async () => {
    const model = new MockEmbeddingModelV4({
      provider: 'test',
      modelId: 'test-embed',
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      doEmbed: async ({ values }) => ({
        embeddings: values.map((value) => [value.charCodeAt(0)]),
        usage: { tokens: values.length },
        warnings: [],
      }),
    })
    const result = await embedPassages(model, ['a', 'b', 'c'], { maxTokensPerCall: 1 })
    expect(result.embeddings).toEqual([[97], [98], [99]])
    expect(result.usage).toEqual({ tokens: 3 })
    expect(model.doEmbedCalls).toHaveLength(3)
  })

  it('packs values into one request when they fit the budget', async () => {
    const model = embeddingModel([
      [1, 0],
      [0, 1],
    ])
    await embedPassages(model, ['a', 'b'], { maxTokensPerCall: 1000 })
    expect(model.doEmbedCalls).toHaveLength(1)
  })

  it('backs off and retries in smaller batches when the provider rejects the size', async () => {
    const succeeded: number[] = []
    let rejected = 0
    const model = new MockEmbeddingModelV4({
      provider: 'test',
      modelId: 'test-embed',
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      doEmbed: async ({ values }) => {
        if (values.length > 3) {
          rejected += 1
          throw new APICallError({
            message: 'Bad Request',
            url: 'http://localhost/v1/embeddings',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: '{"error":{"message":"batch too large"}}',
          })
        }
        succeeded.push(values.length)
        return {
          embeddings: values.map((value) => [value.charCodeAt(0)]),
          usage: { tokens: values.length },
          warnings: [],
        }
      },
    })
    const texts = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i))
    const result = await embedPassages(model, texts)
    expect(result.embeddings).toEqual(texts.map((text) => [text.charCodeAt(0)]))
    expect(rejected).toBeGreaterThan(0)
    expect(Math.max(...succeeded)).toBeLessThanOrEqual(3)

    // The working size is remembered, so a second run on the same model does
    // not re-discover it and does not spend calls against the rate limit.
    const rejectedAfterFirst = rejected
    const second = await embedPassages(model, texts)
    expect(second.embeddings).toEqual(texts.map((text) => [text.charCodeAt(0)]))
    expect(rejected).toBe(rejectedAfterFirst)
  })

  it('waits out a 429 using the reset header, then retries the same batch', async () => {
    let calls = 0
    const model = new MockEmbeddingModelV4({
      provider: 'test',
      modelId: 'rate-limited-embed',
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      doEmbed: async ({ values }) => {
        calls += 1
        if (calls === 1) {
          throw new APICallError({
            message: 'Rate limit reached',
            url: 'http://localhost/v1/embeddings',
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'x-ratelimit-reset-requests': '0s' },
          })
        }
        return {
          embeddings: values.map((value) => [value.charCodeAt(0)]),
          usage: { tokens: values.length },
          warnings: [],
        }
      },
    })
    const result = await embedPassages(model, ['a', 'b'])
    expect(result.embeddings).toEqual([[97], [98]])
    expect(calls).toBe(2)
  })
})

describe('rate limit delay', () => {
  it('parses OpenAI-style reset values', () => {
    expect(parseRateLimitDelayMs('30')).toBe(30_000)
    expect(parseRateLimitDelayMs('1s')).toBe(1_000)
    expect(parseRateLimitDelayMs('1m30s')).toBe(90_000)
    expect(parseRateLimitDelayMs('500ms')).toBe(500)
    expect(parseRateLimitDelayMs('6m0s')).toBe(360_000)
    expect(parseRateLimitDelayMs('whenever')).toBeUndefined()
  })

  it('prefers the reset header and caps an absurd wait', () => {
    const limited = new APICallError({
      message: 'rate limited',
      url: 'http://localhost/v1/embeddings',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'x-ratelimit-reset-requests': '2s' },
    })
    expect(rateLimitDelayMs(limited, 1)).toBe(2_000)

    const huge = new APICallError({
      message: 'rate limited',
      url: 'http://localhost/v1/embeddings',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'x-ratelimit-reset-requests': '30m' },
    })
    expect(rateLimitDelayMs(huge, 1)).toBe(120_000)
  })

  it('falls back to exponential backoff without headers', () => {
    const bare = new APICallError({
      message: 'rate limited',
      url: 'http://localhost/v1/embeddings',
      requestBodyValues: {},
      statusCode: 429,
    })
    expect(rateLimitDelayMs(bare, 1)).toBe(2_000)
    expect(rateLimitDelayMs(bare, 2)).toBe(4_000)
  })
})

describe('embedTokenBudget', () => {
  function settingsWithWindow(window: number | undefined): Settings {
    return {
      ...defaultSettings(),
      providers: [
        {
          id: 'p1',
          label: 'p1',
          kind: 'openai-compatible',
          baseURL: 'http://localhost:11434/v1',
          apiKey: 'k',
          models: [
            {
              id: 'embed-x',
              ...(window === undefined ? {} : { caps: { contextWindow: window } }),
            },
          ],
          defaultModel: 'embed-x',
        },
      ],
    }
  }

  it('uses the embedding model window as the per-call cap', () => {
    expect(embedTokenBudget(settingsWithWindow(32000), 'p1', 'embed-x')).toBe(32000)
  })

  it('falls back to the default budget when the model reports no window', () => {
    expect(embedTokenBudget(settingsWithWindow(undefined), 'p1', 'embed-x')).toBe(
      DEFAULT_MAX_EMBED_REQUEST_TOKENS,
    )
    expect(embedTokenBudget(settingsWithWindow(32000), 'p1', 'missing')).toBe(
      DEFAULT_MAX_EMBED_REQUEST_TOKENS,
    )
  })
})

describe('probeEmbedding', () => {
  it('returns the vector dimension', async () => {
    const model = embeddingModel([[0.1, 0.2, 0.3, 0.4]])
    await expect(probeEmbedding(model, { providerId: 'p1', modelId: 'm' })).resolves.toBe(4)
  })

  it('names the provider and model when the endpoint serves no embedding model', async () => {
    const model = new MockEmbeddingModelV4({
      provider: 'test',
      modelId: 'test-embed',
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      doEmbed: async () => {
        throw new Error('404 no such embedding model')
      },
    })
    await expect(probeEmbedding(model, { providerId: 'p1', modelId: 'text-embed' })).rejects.toThrow(
      /p1.*text-embed/s,
    )
    await expect(probeEmbedding(model, { providerId: 'p1', modelId: 'text-embed' })).rejects.toBeInstanceOf(
      EmbeddingProbeError,
    )
  })

  it('rejects an empty vector as a provider misconfiguration', async () => {
    const model = embeddingModel([[]])
    await expect(probeEmbedding(model, { providerId: 'p1', modelId: 'm' })).rejects.toBeInstanceOf(
      EmbeddingProbeError,
    )
  })
})
