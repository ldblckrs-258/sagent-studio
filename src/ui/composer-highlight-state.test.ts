import { describe, expect, it } from 'vitest'
import { highlightSegments } from './composer-highlight-state'

const known = {
  commands: new Set(['compact', 'plan@workspace']),
  paths: new Set(['src/chat/engine.ts', 'docs']),
}

function kinds(text: string) {
  return highlightSegments(text, known).map((segment) => [segment.kind, segment.text])
}

describe('highlightSegments', () => {
  it('paints a command only once its name resolves', () => {
    expect(kinds('/compact')).toEqual([['command', '/compact']])
    // Half-typed is not a command yet, so colouring it would promise something
    // the composer cannot deliver.
    expect(kinds('/comp')).toEqual([['plain', '/comp']])
    expect(kinds('/unknown')).toEqual([['plain', '/unknown']])
  })

  it('keeps command arguments plain', () => {
    expect(kinds('/compact keep the API notes')).toEqual([
      ['command', '/compact'],
      ['plain', ' keep the API notes'],
    ])
  })

  it('handles a disambiguated skill id and leading whitespace', () => {
    expect(kinds('  /plan@workspace go')).toEqual([
      ['plain', '  '],
      ['command', '/plan@workspace'],
      ['plain', ' go'],
    ])
  })

  it('paints a mention only when that path is actually attached', () => {
    expect(kinds('look at @src/chat/engine.ts please')).toEqual([
      ['plain', 'look at '],
      ['mention', '@src/chat/engine.ts'],
      ['plain', ' please'],
    ])
    expect(kinds('look at @src/chat/eng')).toEqual([
      ['plain', 'look at @src/chat/eng'],
    ])
  })

  it('ignores an @ inside a word, so an email stays plain', () => {
    expect(kinds('mail me@src/chat/engine.ts')).toEqual([
      ['plain', 'mail me@src/chat/engine.ts'],
    ])
  })

  it('paints several mentions and a folder', () => {
    expect(kinds('@docs and @src/chat/engine.ts')).toEqual([
      ['mention', '@docs'],
      ['plain', ' and '],
      ['mention', '@src/chat/engine.ts'],
    ])
  })

  it('returns nothing for empty text', () => {
    expect(highlightSegments('', known)).toEqual([])
  })
})
