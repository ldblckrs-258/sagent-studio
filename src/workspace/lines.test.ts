import { describe, expect, it } from 'vitest'
import { countLines, sliceLines, splitLines } from './lines'

describe('splitLines', () => {
  it('splits CRLF without a trailing carriage return', () => {
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('does not invent an extra empty line for a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

describe('countLines', () => {
  it('counts logical lines', () => {
    expect(countLines('a\nb\nc')).toBe(3)
    expect(countLines('')).toBe(0)
  })
})

describe('sliceLines', () => {
  const text = 'one\ntwo\nthree\nfour'

  it('returns every line with no options and truncated false', () => {
    expect(sliceLines(text, {})).toEqual({
      content: text,
      totalLines: 4,
      returnedLines: 4,
      offset: 1,
      truncated: false,
    })
  })

  it('returns exactly the 1-based window', () => {
    const window = sliceLines(text, { offset: 2, limit: 1 })
    expect(window.content).toBe('two')
    expect(window.offset).toBe(2)
    expect(window.returnedLines).toBe(1)
    expect(window.truncated).toBe(true)
    expect(window.totalLines).toBeGreaterThan(window.returnedLines)
  })

  it('returns zero lines and truncated false when the offset is past the end', () => {
    expect(sliceLines(text, { offset: 99, limit: 5 })).toMatchObject({
      content: '',
      returnedLines: 0,
      truncated: false,
    })
  })
})
