import { describe, expect, it } from 'vitest'
import type { ModelConfig, Settings } from '../vault/settings'
import { defaultSettings } from '../vault/settings'
import { activeModel, contextWindowFor, modelSupportsVision } from './model-caps'

function settingsWith(models: ModelConfig[], defaultModel = 'm1'): Settings {
  const base = defaultSettings()
  return {
    ...base,
    providers: [
      {
        id: 'p1',
        label: 'P',
        kind: 'openai-compatible',
        baseURL: 'http://localhost/v1',
        apiKey: 'k',
        models,
        defaultModel,
      },
    ],
  }
}

describe('activeModel', () => {
  it('falls back to the first provider and its default when nothing is selected', () => {
    const settings = settingsWith([{ id: 'm1' }])
    expect(activeModel(settings, undefined, undefined)?.id).toBe('m1')
  })

  it('prefers the selected model, then the default it names', () => {
    const settings = settingsWith([{ id: 'm1' }, { id: 'm2' }], 'm2')
    expect(activeModel(settings, 'p1', 'm1')?.id).toBe('m1')
    expect(activeModel(settings, 'p1', 'missing')?.id).toBe('m2')
  })

  it('returns undefined while the vault is locked', () => {
    expect(activeModel(null, 'p1', 'm1')).toBeUndefined()
  })
})

describe('contextWindowFor', () => {
  it('returns the reported window', () => {
    const settings = settingsWith([{ id: 'm1', caps: { contextWindow: 200_000 } }])
    expect(contextWindowFor(settings, 'p1', 'm1')).toBe(200_000)
  })

  it('returns undefined for a model with no caps', () => {
    expect(contextWindowFor(settingsWith([{ id: 'm1' }]), 'p1', 'm1')).toBeUndefined()
  })

  it('ignores a malformed window rather than capping at a bad value', () => {
    const settings = settingsWith([{ id: 'm1', caps: { contextWindow: 0 } }])
    expect(contextWindowFor(settings, 'p1', 'm1')).toBeUndefined()
  })
})

describe('modelSupportsVision', () => {
  it('assumes vision when the cap is unknown', () => {
    expect(modelSupportsVision(settingsWith([{ id: 'm1' }]), 'p1', 'm1')).toBe(true)
  })

  it('honors an explicit false', () => {
    const settings = settingsWith([{ id: 'm1', caps: { vision: false } }])
    expect(modelSupportsVision(settings, 'p1', 'm1')).toBe(false)
  })

  it('assumes vision when no model can be resolved', () => {
    expect(modelSupportsVision(settingsWith([]), 'p1', 'm1')).toBe(true)
  })
})
