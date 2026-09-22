import type { LanguageModel } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, MODEL_TIERS } from '../vault/settings'
import type { ProviderConfig, Settings } from '../vault/settings'
import {
  MODEL_TIER_META,
  createTierModel,
  resolveTierModel,
  tierForMode,
} from './model-tier'

function provider(id: string): ProviderConfig {
  return {
    id,
    label: id,
    kind: 'openai-compatible',
    baseURL: 'https://example.com/v1',
    apiKey: 'k',
    models: [{ id: 'm1' }, { id: 'm2' }],
    defaultModel: 'm1',
  }
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), providers: [provider('p1')], ...patch }
}

describe('MODEL_TIER_META', () => {
  it('names every tier', () => {
    expect(Object.keys(MODEL_TIER_META).sort()).toEqual([...MODEL_TIERS].sort())
    for (const tier of MODEL_TIERS) {
      expect(MODEL_TIER_META[tier].label.length).toBeGreaterThan(0)
      expect(MODEL_TIER_META[tier].blurb.length).toBeGreaterThan(0)
    }
  })
})

describe('tierForMode', () => {
  it('maps each mode to a tier, never choosing max implicitly', () => {
    expect(tierForMode('read_only')).toBe('cheap')
    expect(tierForMode('editing')).toBe('medium')
    expect(tierForMode('god')).toBe('high')
  })
})

describe('resolveTierModel', () => {
  it('is null when the tier is not configured', () => {
    expect(resolveTierModel(settings(), 'cheap')).toBeNull()
  })

  it('resolves provider and model when both are set', () => {
    expect(
      resolveTierModel(settings({ modelTiers: { cheap: { providerId: 'p1', modelId: 'm2' } } }), 'cheap'),
    ).toEqual({ providerId: 'p1', modelId: 'm2' })
  })

  it('omits the model when only a provider is set', () => {
    expect(
      resolveTierModel(settings({ modelTiers: { high: { providerId: 'p1' } } }), 'high'),
    ).toEqual({ providerId: 'p1' })
  })

  it('is null when the provider no longer exists', () => {
    expect(
      resolveTierModel(settings({ modelTiers: { cheap: { providerId: 'gone' } } }), 'cheap'),
    ).toBeNull()
  })

  it('resolves each tier independently', () => {
    const configured = settings({
      modelTiers: {
        cheap: { providerId: 'p1', modelId: 'm1' },
        max: { providerId: 'p1', modelId: 'm2' },
      },
    })
    expect(resolveTierModel(configured, 'cheap')).toEqual({ providerId: 'p1', modelId: 'm1' })
    expect(resolveTierModel(configured, 'medium')).toBeNull()
    expect(resolveTierModel(configured, 'max')).toEqual({ providerId: 'p1', modelId: 'm2' })
  })
})

describe('createTierModel', () => {
  it('builds through the factory with the resolved ids', () => {
    const model = { modelId: 'm2' } as unknown as LanguageModel
    const factory = vi.fn(() => model)
    const built = createTierModel(
      settings({ modelTiers: { cheap: { providerId: 'p1', modelId: 'm2' } } }),
      'cheap',
      factory,
    )
    expect(built).toBe(model)
    expect(factory).toHaveBeenCalledWith(expect.anything(), 'p1', 'm2')
  })

  it('is null and does not call the factory when the tier is unconfigured', () => {
    const factory = vi.fn()
    expect(createTierModel(settings(), 'cheap', factory)).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('swallows a factory failure and returns null', () => {
    const factory = vi.fn(() => {
      throw new Error('bad provider')
    })
    expect(
      createTierModel(settings({ modelTiers: { cheap: { providerId: 'p1' } } }), 'cheap', factory),
    ).toBeNull()
  })
})
