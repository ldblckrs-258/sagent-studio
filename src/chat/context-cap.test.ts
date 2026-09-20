import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../vault/settings'
import type { Settings } from '../vault/settings'
import {
  autoCompactThreshold,
  resolveContextCap,
  shouldAutoCompact,
} from './context-cap'

function settingsWith(context: Partial<Settings['context']>): Settings {
  const base = defaultSettings()
  return { ...base, context: { ...base.context, ...context } }
}

describe('resolveContextCap', () => {
  it('reads the global block when the thread sets no override', () => {
    const cap = resolveContextCap(settingsWith({ maxContextTokens: 64_000 }))
    expect(cap.maxContextTokens).toBe(64_000)
    expect(cap.autoCompactRatio).toBe(0.8)
    expect(cap.autoCompactEnabled).toBe(true)
  })

  it('prefers the thread override for the window', () => {
    const cap = resolveContextCap(settingsWith({ maxContextTokens: 64_000 }), {
      maxContextTokens: 200_000,
    })
    expect(cap.maxContextTokens).toBe(200_000)
  })

  it('keeps the ratio and the switch global even when the window is overridden', () => {
    const cap = resolveContextCap(
      settingsWith({ autoCompactRatio: 0.5, autoCompactEnabled: false }),
      { maxContextTokens: 200_000 },
    )
    expect(cap.autoCompactRatio).toBe(0.5)
    expect(cap.autoCompactEnabled).toBe(false)
  })

  it('falls back to the defaults while the vault is locked', () => {
    expect(resolveContextCap(null).maxContextTokens).toBe(128_000)
  })

  it('ignores a non-positive override rather than capping the thread at zero', () => {
    const cap = resolveContextCap(settingsWith({}), { maxContextTokens: 0 })
    expect(cap.maxContextTokens).toBe(128_000)
  })
})

describe('shouldAutoCompact', () => {
  it('fires at the threshold, not only past it', () => {
    const cap = resolveContextCap(
      settingsWith({ maxContextTokens: 1000, autoCompactRatio: 0.8 }),
    )
    expect(autoCompactThreshold(cap)).toBe(800)
    expect(shouldAutoCompact(799, cap)).toBe(false)
    expect(shouldAutoCompact(800, cap)).toBe(true)
    expect(shouldAutoCompact(801, cap)).toBe(true)
  })

  it('never fires while the switch is off, however large the context', () => {
    const cap = resolveContextCap(
      settingsWith({ maxContextTokens: 1000, autoCompactEnabled: false }),
    )
    expect(shouldAutoCompact(10_000_000, cap)).toBe(false)
  })
})
