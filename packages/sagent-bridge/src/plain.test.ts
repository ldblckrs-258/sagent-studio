import { describe, expect, it } from 'vitest'
import { toPlain } from './plain.js'

describe('toPlain', () => {
  it('strips colors and normalizes CRLF', () => {
    expect(toPlain(Buffer.from('\x1b[31mred\x1b[0m\r\nok\r\n'), false)).toBe('red\nok\n')
  })

  it('keeps only the final state of a carriage-return progress bar', () => {
    expect(toPlain(Buffer.from('10%\r50%\r100%\ndone'), false)).toBe('100%\ndone')
  })

  it('drops the remainder of an escape sequence cut at the window start', () => {
    expect(toPlain(Buffer.from('[31mred\x1b[0m'), true)).toBe('red')
    expect(toPlain(Buffer.from(']0;title\x07prompt$ '), true)).toBe('prompt$ ')
  })

  it('does not eat leading text when the window is at the stream start', () => {
    expect(toPlain(Buffer.from('[1] done'), false)).toBe('[1] done')
  })

  it('applies backspaces from shell echo', () => {
    expect(toPlain(Buffer.from('lss\b \b\n'), false)).toBe('ls\n')
  })
})
