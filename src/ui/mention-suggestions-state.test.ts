import { describe, expect, it } from 'vitest'
import { completeMention, mentionQueryAt } from './mention-suggestions-state'

describe('mentionQueryAt', () => {
  it('opens on an @ that starts a word, mid-message', () => {
    const text = 'please read @eng'
    expect(mentionQueryAt(text, text.length)).toEqual({
      query: 'eng',
      start: 12,
      end: 16,
    })
    expect(mentionQueryAt('@', 1)).toEqual({ query: '', start: 0, end: 1 })
  })

  it('stays shut inside a word, so an email never opens it', () => {
    expect(mentionQueryAt('a@b', 3)).toBeNull()
    expect(mentionQueryAt('name@example.com', 16)).toBeNull()
  })

  it('closes once the query takes whitespace', () => {
    expect(mentionQueryAt('@src/a.ts and then', 18)).toBeNull()
    expect(mentionQueryAt('@src/a.ts ', 10)).toBeNull()
  })

  it('reads the caret, not the end of the text', () => {
    const text = '@eng and more'
    expect(mentionQueryAt(text, 4)?.query).toBe('eng')
    expect(mentionQueryAt(text, text.length)).toBeNull()
  })

  it('returns null when there is no @ before the caret', () => {
    expect(mentionQueryAt('plain text', 5)).toBeNull()
  })
})

describe('completeMention', () => {
  it('replaces only the mention and leaves the caret after it', () => {
    const text = 'look at @eng then stop'
    const match = mentionQueryAt(text, 12)
    expect(match).not.toBeNull()
    const result = completeMention(text, match!, 'src/chat/engine.ts')
    expect(result.text).toBe('look at @src/chat/engine.ts then stop')
    expect(result.caret).toBe('look at @src/chat/engine.ts '.length)
    // The caret lands where the user was typing, not at the end of the text.
    expect(result.text.slice(result.caret)).toBe('then stop')
  })

  it('closes the popover by completing with a trailing space', () => {
    const text = '@eng'
    const match = mentionQueryAt(text, text.length)!
    const result = completeMention(text, match, 'src/chat/engine.ts')
    expect(mentionQueryAt(result.text, result.caret)).toBeNull()
  })
})

describe('completeMention, descending', () => {
  it('opens a folder instead of taking it', () => {
    const text = '@src'
    const match = mentionQueryAt(text, text.length)!
    const result = completeMention(text, match, 'src', { descend: true })
    expect(result.text).toBe('@src/')
    expect(result.caret).toBe(5)
    // The popover has to stay open on the folder's children, so the query
    // continues rather than ending in the whitespace that closes it.
    expect(mentionQueryAt(result.text, result.caret)?.query).toBe('src/')
  })

  it('keeps the rest of the message untouched while descending', () => {
    const text = 'look at @src then stop'
    const match = mentionQueryAt(text, 12)!
    const result = completeMention(text, match, 'src', { descend: true })
    expect(result.text).toBe('look at @src/ then stop')
    expect(result.text.slice(result.caret)).toBe(' then stop')
  })
})
