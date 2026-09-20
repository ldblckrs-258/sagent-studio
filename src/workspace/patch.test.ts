import { describe, expect, it } from 'vitest'
import { countOccurrences, planPatch } from './patch'

describe('countOccurrences', () => {
  it('returns 1-based line numbers of every non-overlapping match', () => {
    expect(countOccurrences('alpha\nbeta\nalpha\n', 'alpha')).toEqual([1, 3])
  })

  it('counts non-overlapping occurrences of overlapping-looking input', () => {
    expect(countOccurrences('aaa', 'aa')).toEqual([1])
  })
})

describe('planPatch', () => {
  it('returns no_match when the needle is absent', () => {
    const plan = planPatch('abc', 'zzz', 'yyy')
    expect(plan).toMatchObject({ ok: false, code: 'no_match' })
    expect('content' in plan).toBe(false)
  })

  it('returns multiple_matches with the line numbers when not replace_all', () => {
    const plan = planPatch('alpha\nbeta\nalpha\n', 'alpha', 'omega')
    expect(plan).toMatchObject({ ok: false, code: 'multiple_matches', lines: [1, 3] })
    expect('content' in plan).toBe(false)
  })

  it('replaces a unique occurrence', () => {
    expect(planPatch('one two three', 'two', 'TWO')).toEqual({
      ok: true,
      content: 'one TWO three',
      replacements: 1,
      linesChanged: [1],
    })
  })

  it('replaces every occurrence with replace_all', () => {
    expect(planPatch('a\nb\na\n', 'a', 'x', true)).toEqual({
      ok: true,
      content: 'x\nb\nx\n',
      replacements: 2,
      linesChanged: [1, 3],
    })
  })

  it('reports zero effective changes when new_string equals old_string', () => {
    expect(planPatch('same', 'same', 'same')).toEqual({
      ok: true,
      content: 'same',
      replacements: 0,
      linesChanged: [],
    })
  })

  it('rejects an empty old_string without scanning', () => {
    expect(planPatch('abc', '', 'x')).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('round-trips CRLF content without changing line endings', () => {
    const plan = planPatch('a\r\nb\r\n', 'b', 'B')
    expect(plan).toEqual({ ok: true, content: 'a\r\nB\r\n', replacements: 1, linesChanged: [2] })
  })
})
