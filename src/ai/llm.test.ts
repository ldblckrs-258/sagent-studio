import { describe, expect, it } from 'vitest'
import { createLLM } from './llm'
import { LLMConfigError, resolveProvider, validateProvider } from './providers'
import type { ProviderConfig } from '../vault/settings'
import { defaultSettings } from '../vault/settings'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'local',
    label: 'Local',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'test-key',
    models: [{ id: 'llama3' }, { id: 'mixtral' }],
    defaultModel: 'llama3',
    ...overrides,
  }
}

function settingsWith(providers: ProviderConfig[]) {
  return { ...defaultSettings(), providers }
}

function modelDescriptor(model: unknown): { specificationVersion?: string; modelId?: string } {
  return model as { specificationVersion?: string; modelId?: string }
}

describe('validateProvider', () => {
  it('accepts a complete provider', () => {
    expect(validateProvider(provider())).toEqual({})
  })

  it('rejects a missing api key', () => {
    expect(validateProvider(provider({ apiKey: '' })).apiKey).toBeTruthy()
  })

  it('rejects a non-http base URL', () => {
    expect(validateProvider(provider({ baseURL: 'ftp://example.com' })).baseURL).toBeTruthy()
  })

  it('rejects a default model not in the model list', () => {
    expect(validateProvider(provider({ defaultModel: 'gpt-4' })).defaultModel).toBeTruthy()
  })

  it('rejects an over-long model list', () => {
    const models = Array.from({ length: 501 }, (_, i) => ({ id: `model-${i}` }))
    expect(validateProvider(provider({ models, defaultModel: 'model-0' })).models).toBeTruthy()
  })
})

describe('resolveProvider', () => {
  it('returns the matching provider', () => {
    expect(resolveProvider([provider()], 'local').id).toBe('local')
  })

  it('throws LLMConfigError for an unknown id', () => {
    expect(() => resolveProvider([provider()], 'missing')).toThrow(LLMConfigError)
  })

  it('throws LLMConfigError for an invalid provider', () => {
    expect(() => resolveProvider([provider({ apiKey: '' })], 'local')).toThrow(LLMConfigError)
  })

  it('never returns undefined', () => {
    expect(() => resolveProvider([], 'x')).toThrow(LLMConfigError)
  })
})

describe('createLLM', () => {
  it('returns a language model for a valid provider', () => {
    const model = createLLM(settingsWith([provider()]), 'local')
    expect(model).toBeTruthy()
    expect(modelDescriptor(model).specificationVersion).toBe('v4')
  })

  it('honors a model override', () => {
    const model = createLLM(settingsWith([provider()]), 'local', 'mixtral')
    expect(modelDescriptor(model).modelId).toBe('mixtral')
  })

  it('falls back to the provider default model', () => {
    const model = createLLM(settingsWith([provider()]), 'local')
    expect(modelDescriptor(model).modelId).toBe('llama3')
  })

  it('throws LLMConfigError for a missing provider', () => {
    expect(() => createLLM(settingsWith([]), 'nope')).toThrow(LLMConfigError)
  })
})
