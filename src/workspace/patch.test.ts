import { describe, expect, it } from 'vitest'
import { countOccurrences, planPatch, planPatchMulti } from './patch'

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

  it('marks an absent needle whose replacement is already present as satisfied', () => {
    expect(planPatch('hello world', 'goodbye', 'world')).toMatchObject({
      ok: true,
      content: 'hello world',
      replacements: 0,
      alreadySatisfied: true,
    })
  })
})

describe('planPatchMulti', () => {
  it('applies every hunk against the evolving revision', () => {
    const plan = planPatchMulti('one two three four', [
      { oldString: 'one', newString: '1' },
      { oldString: 'three', newString: '3' },
    ])
    expect(plan).toMatchObject({
      ok: true,
      content: '1 two 3 four',
      replacements: 2,
      alreadySatisfied: false,
    })
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.edits).toEqual([
      { index: 0, replacements: 1, linesChanged: [1], applied: true },
      { index: 1, replacements: 1, linesChanged: [1], applied: true },
    ])
  })

  it('fails the whole batch at the first bad hunk', () => {
    const plan = planPatchMulti('one two', [
      { oldString: 'two', newString: '2' },
      { oldString: 'missing', newString: 'x' },
    ])
    expect(plan).toMatchObject({ ok: false, code: 'no_match', failedIndex: 1 })
    expect('content' in plan).toBe(false)
  })

  it('requires at least one edit', () => {
    expect(planPatchMulti('abc', [])).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('reports a fully applied batch as idempotent rather than no_match', () => {
    const plan = planPatchMulti('BETA GAMMA', [
      { oldString: 'beta', newString: 'BETA' },
      { oldString: 'gamma', newString: 'GAMMA' },
    ])
    expect(plan).toMatchObject({
      ok: true,
      replacements: 0,
      alreadySatisfied: true,
      edits: [
        { index: 0, applied: false, reason: 'already_satisfied' },
        { index: 1, applied: false, reason: 'already_satisfied' },
      ],
    })
  })

  it('reports alreadySatisfied only when nothing was applied', () => {
    const mixed = planPatchMulti('A B', [
      { oldString: 'A', newString: 'X' },
      { oldString: 'B', newString: 'B' },
    ])
    expect(mixed).toMatchObject({ ok: true, replacements: 1, alreadySatisfied: false })

    const satisfied = planPatchMulti('A B', [{ oldString: 'Q', newString: 'B' }])
    expect(satisfied).toMatchObject({ ok: true, replacements: 0, alreadySatisfied: true })
  })
})
