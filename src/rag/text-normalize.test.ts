import { describe, expect, it } from 'vitest'
import { normalizeVietnameseSyllableSplits, repairMissingSyllableSpaces } from './text-normalize'

describe('normalizeVietnameseSyllableSplits', () => {
  it('rejoins a space injected inside a syllable', () => {
    expect(normalizeVietnameseSyllableSplits('pháp quyề n')).toBe('pháp quyền')
    expect(normalizeVietnameseSyllableSplits('cộ ng hòa')).toBe('cộng hòa')
    expect(normalizeVietnameseSyllableSplits('chủ nghĩ a')).toBe('chủ nghĩa')
    expect(normalizeVietnameseSyllableSplits('xã hộ i')).toBe('xã hội')
    expect(normalizeVietnameseSyllableSplits('trậ t tự')).toBe('trật tự')
  })

  it('rejoins a split before an accented vowel fragment', () => {
    expect(normalizeVietnameseSyllableSplits('dư ới')).toBe('dưới')
    expect(normalizeVietnameseSyllableSplits('nư ớc')).toBe('nước')
    expect(normalizeVietnameseSyllableSplits('c ủa')).toBe('của')
    expect(normalizeVietnameseSyllableSplits('đi ều')).toBe('điều')
    expect(normalizeVietnameseSyllableSplits('b ản')).toBe('bản')
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

describe('repairMissingSyllableSpaces', () => {
  it('splits a run of two glued syllables', () => {
    expect(repairMissingSyllableSpaces('lợiích')).toBe('lợi ích')
    expect(repairMissingSyllableSpaces('cóý nghĩa')).toBe('có ý nghĩa')
    expect(repairMissingSyllableSpaces('vớiý')).toBe('với ý')
    expect(repairMissingSyllableSpaces('lấyý kiến')).toBe('lấy ý kiến')
    expect(repairMissingSyllableSpaces('choý chí')).toBe('cho ý chí')
    expect(repairMissingSyllableSpaces('tựý thức')).toBe('tự ý thức')
    expect(repairMissingSyllableSpaces('vàý nghĩa')).toBe('và ý nghĩa')
  })

  it('leaves a valid syllable and a non-Vietnamese word alone', () => {
    expect(repairMissingSyllableSpaces('người')).toBe('người')
    expect(repairMissingSyllableSpaces('page word')).toBe('page word')
    expect(repairMissingSyllableSpaces('Internet worker')).toBe('Internet worker')
  })
})
