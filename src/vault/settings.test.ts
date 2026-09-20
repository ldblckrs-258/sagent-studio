import { describe, expect, it } from 'vitest'
import { DEFAULT_JS_TIMEOUT_MS } from '../sandbox/js-runner'
import { DEFAULT_PY_TIMEOUT_MS } from '../sandbox/py-runner'
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
  deepMerge,
  defaultSettings,
  migrate,
  SETTINGS_VERSION,
  validateContextSettings,
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

  it('defaults idleTimeoutMs to 300000', () => {
    expect(defaultSettings().sandbox.idleTimeoutMs).toBe(300_000)
    expect(DEFAULT_SANDBOX_IDLE_TIMEOUT_MS).toBe(300_000)
  })

  it('fills idleTimeoutMs for a sandbox record written without it', () => {
    const migrated = migrate(1, {
      sandbox: { enabled: true, jsTimeoutMs: 1000, pyTimeoutMs: 2000 },
    })
    expect(migrated.sandbox).toEqual({
      enabled: true,
      jsTimeoutMs: 1000,
      pyTimeoutMs: 2000,
      idleTimeoutMs: 300_000,
    })
  })
})

describe('approval settings', () => {
  it('defaults to an empty policy and fills it on migrate', () => {
    expect(defaultSettings().approvals).toEqual({ tools: {} })
    const migrated = migrate(1, { sandbox: { enabled: true } })
    expect(migrated.approvals).toEqual({ tools: {} })
  })

  it('preserves a persisted policy through migrate', () => {
    const migrated = migrate(1, { approvals: { tools: { write_file: 'allow' } } })
    expect(migrated.approvals).toEqual({ tools: { write_file: 'allow' } })
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

describe('context settings', () => {
  it('defaults to a 128k cap that auto-compacts at 80 percent', () => {
    expect(defaultSettings().context).toEqual({
      maxContextTokens: 128_000,
      autoCompactRatio: 0.8,
      autoCompactEnabled: true,
    })
  })

  it('fills the block for a vault saved before it existed', () => {
    const migrated = migrate(1, { idleLockMinutes: 30 })
    expect(migrated.context).toEqual(defaultSettings().context)
    expect(migrated.idleLockMinutes).toBe(30)
  })

  it('keeps a stored block that is in range', () => {
    const migrated = migrate(1, {
      context: { maxContextTokens: 32_000, autoCompactRatio: 0.5, autoCompactEnabled: false },
    })
    expect(migrated.context).toEqual({
      maxContextTokens: 32_000,
      autoCompactRatio: 0.5,
      autoCompactEnabled: false,
    })
  })

  it('repairs an out-of-range block instead of refusing to unlock the vault', () => {
    const migrated = migrate(1, { context: { autoCompactRatio: 5 } })
    expect(migrated.context).toEqual(defaultSettings().context)
  })

  it('rejects a non-integer cap with a message naming the field', () => {
    expect(() =>
      validateContextSettings({
        maxContextTokens: 1.5,
        autoCompactRatio: 0.8,
        autoCompactEnabled: true,
      }),
    ).toThrow(/maxContextTokens must be a positive integer/)
  })

  it('rejects a ratio outside the usable band with a message naming the bounds', () => {
    expect(() =>
      validateContextSettings({
        maxContextTokens: 1000,
        autoCompactRatio: 0.99,
        autoCompactEnabled: true,
      }),
    ).toThrow(/autoCompactRatio must be between 0.1 and 0.95/)
  })
})
