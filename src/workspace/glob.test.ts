import { describe, expect, it } from 'vitest'
import { matchesGlob } from './glob'

describe('matchesGlob', () => {
  it('matches nested and root paths for **/*.ts', () => {
    expect(matchesGlob('**/*.ts', 'src/index.ts')).toBe(true)
    expect(matchesGlob('**/*.ts', 'src/deep/index.ts')).toBe(true)
    expect(matchesGlob('**/*.ts', 'index.ts')).toBe(true)
  })

  it('matches one level only for src/*', () => {
    expect(matchesGlob('src/*', 'src/index.ts')).toBe(true)
    expect(matchesGlob('src/*', 'src/deep/index.ts')).toBe(false)
    expect(matchesGlob('src/*', 'other/index.ts')).toBe(false)
  })

  it('matches exactly one character per ?', () => {
    expect(matchesGlob('a?c', 'abc')).toBe(true)
    expect(matchesGlob('a?c', 'ac')).toBe(false)
    expect(matchesGlob('a?c', 'a/c')).toBe(false)
  })

  it('treats a literal dot as a literal', () => {
    expect(matchesGlob('a.txt', 'a.txt')).toBe(true)
    expect(matchesGlob('a.txt', 'axtxt')).toBe(false)
  })

  it('returns false instead of throwing on invalid input', () => {
    expect(matchesGlob(undefined as unknown as string, 'a.ts')).toBe(false)
    expect(matchesGlob('*.ts', undefined as unknown as string)).toBe(false)
  })
})
