import { describe, expect, it } from 'vitest'
import { DEFAULT_JS_TIMEOUT_MS } from '../sandbox/js-runner'
import { DEFAULT_PY_TIMEOUT_MS } from '../sandbox/py-runner'
import {
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
  deepMerge,
  defaultSettings,
  migrate,
  SETTINGS_VERSION,
} from './settings'
import { VaultMigrationError } from './errors'

describe('defaultSettings', () => {
  it('matches the current schema version', () => {
    expect(defaultSettings().version).toBe(SETTINGS_VERSION)
  })

  it('has no providers and an empty typesafe key', () => {
    const settings = defaultSettings()
    expect(settings.providers).toEqual([])
    expect(settings.typesafe.apiKey).toBe('')
  })

  it('returns a fresh object each call', () => {
    const a = defaultSettings()
    a.providers.push({
      id: 'x',
      label: 'x',
      kind: 'openai-compatible',
      baseURL: '',
      apiKey: '',
      models: [],
      defaultModel: '',
    })
    expect(defaultSettings().providers).toEqual([])
  })
})

describe('sandbox settings', () => {
  it('defaults match the runner timeout constants', () => {
    const sandbox = defaultSettings().sandbox
    expect(sandbox.enabled).toBe(true)
    expect(sandbox.jsTimeoutMs).toBe(DEFAULT_JS_TIMEOUT_MS)
    expect(sandbox.pyTimeoutMs).toBe(DEFAULT_PY_TIMEOUT_MS)
    expect(DEFAULT_SANDBOX_JS_TIMEOUT_MS).toBe(DEFAULT_JS_TIMEOUT_MS)
    expect(DEFAULT_SANDBOX_PY_TIMEOUT_MS).toBe(DEFAULT_PY_TIMEOUT_MS)
  })

  it('fills a missing sandbox slice on migrate without a version bump', () => {
    const migrated = migrate(1, { idleLockMinutes: 30 })
    expect(migrated.version).toBe(1)
    expect(migrated.sandbox).toEqual(defaultSettings().sandbox)
    expect(migrated.idleLockMinutes).toBe(30)
  })
})

describe('deepMerge', () => {
  it('merges nested objects without dropping siblings', () => {
    const base = defaultSettings()
    const merged = deepMerge(base, { rag: { topK: 9 } })
    expect(merged.rag.topK).toBe(9)
    expect(merged.rag.chunkSize).toBe(base.rag.chunkSize)
  })

  it('replaces arrays rather than merging them', () => {
    const base = defaultSettings()
    const provider = {
      id: 'p1',
      label: 'Local',
      kind: 'openai-compatible' as const,
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'secret',
      models: ['llama3'],
      defaultModel: 'llama3',
    }
    const merged = deepMerge(base, { providers: [provider] })
    expect(merged.providers).toHaveLength(1)
    expect(merged.providers[0].label).toBe('Local')
  })

  it('ignores undefined patch values', () => {
    const base = defaultSettings()
    const merged = deepMerge(base, { typesafe: { apiKey: undefined, model: 'other' } })
    expect(merged.typesafe.model).toBe('other')
    expect(merged.typesafe.apiKey).toBe('')
  })

  it('does not mutate the base object', () => {
    const base = defaultSettings()
    deepMerge(base, { rag: { topK: 42 } })
    expect(base.rag.topK).toBe(5)
  })
})

describe('migrate', () => {
  it('fills missing fields from defaults at version 1', () => {
    const migrated = migrate(1, { rag: { topK: 7 } })
    expect(migrated.version).toBe(1)
    expect(migrated.rag.topK).toBe(7)
    expect(migrated.rag.concurrency).toBe(2)
  })

  it('throws on a future version instead of discarding data', () => {
    expect(() => migrate(SETTINGS_VERSION + 1, {})).toThrow(VaultMigrationError)
  })

  it('throws on a non-positive version', () => {
    expect(() => migrate(0, {})).toThrow(VaultMigrationError)
  })

  it('rejects non-object decrypted data instead of returning it verbatim', () => {
    expect(() => migrate(1, null)).toThrow(VaultMigrationError)
    expect(() => migrate(1, 'x')).toThrow(VaultMigrationError)
    expect(() => migrate(1, 42)).toThrow(VaultMigrationError)
  })

  it('ignores __proto__ keys so a decrypted blob cannot set a prototype', () => {
    const payload = JSON.parse('{"__proto__":{"injected":"yes"},"version":1}') as Record<
      string,
      unknown
    >
    const merged = migrate(1, payload)
    expect((merged as unknown as Record<string, unknown>).injected).toBeUndefined()
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  })
})
