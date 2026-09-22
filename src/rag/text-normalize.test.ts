import { describe, expect, it } from 'vitest'
import { normalizeVietnameseSyllableSplits } from './text-normalize'

describe('normalizeVietnameseSyllableSplits', () => {
  it('rejoins a space injected inside a syllable', () => {
    expect(normalizeVietnameseSyllableSplits('pháp quyề n')).toBe('pháp quyền')
    expect(normalizeVietnameseSyllableSplits('cộ ng hòa')).toBe('cộng hòa')
    expect(normalizeVietnameseSyllableSplits('chủ nghĩ a')).toBe('chủ nghĩa')
    expect(normalizeVietnameseSyllableSplits('xã hộ i')).toBe('xã hội')
    expect(normalizeVietnameseSyllableSplits('trậ t tự')).toBe('trật tự')
  })

  it('leaves real word boundaries alone', () => {
    expect(normalizeVietnameseSyllableSplits('Bộ trưởng Bộ Ngoại giao')).toBe(
      'Bộ trưởng Bộ Ngoại giao',
    )
    expect(normalizeVietnameseSyllableSplits('đã ra')).toBe('đã ra')
    expect(normalizeVietnameseSyllableSplits('có ai')).toBe('có ai')
    expect(normalizeVietnameseSyllableSplits('và em')).toBe('và em')
    expect(normalizeVietnameseSyllableSplits('có ăn')).toBe('có ăn')
    expect(normalizeVietnameseSyllableSplits('quyền lợi')).toBe('quyền lợi')
  })
})
