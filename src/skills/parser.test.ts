import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from './parser'
import { SkillParseError } from './schema'

describe('parseSkillMarkdown', () => {
  it('parses a frontmatter block with an allowed-tools array', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: Review', 'description: Review code', 'allowed-tools:', '  - read_file', '  - list_dir', '---', 'Follow the steps.'].join('\n'),
      'fallback',
    )
    expect(parsed).toEqual({
      name: 'Review',
      description: 'Review code',
      instructions: 'Follow the steps.',
      allowedTools: ['read_file', 'list_dir'],
    })
  })

  it('parses allowed-tools written as a string', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: Review', 'allowed-tools: read_file, list_dir', '---', 'Body'].join('\n'),
      'fallback',
    )
    expect(parsed.allowedTools).toEqual(['read_file', 'list_dir'])
  })

  it('accepts the camelCase allowedTools key', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: Review', 'allowedTools: [read_file]', '---', 'Body'].join('\n'),
      'fallback',
    )
    expect(parsed.allowedTools).toEqual(['read_file'])
  })

  it('folds a multi-line description', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: Review', 'description: >', '  line one', '  line two', '---', 'Body'].join('\n'),
      'fallback',
    )
    expect(parsed.description).toBe('line one line two')
  })

  it('falls back to the provided name when frontmatter is missing', () => {
    const parsed = parseSkillMarkdown('Just a body.', 'from-directory')
    expect(parsed).toEqual({
      name: 'from-directory',
      description: '',
      instructions: 'Just a body.',
      allowedTools: [],
    })
  })

  it('uses the fallback name when the frontmatter name is blank', () => {
    const parsed = parseSkillMarkdown(['---', 'name: "  "', '---', 'Body'].join('\n'), 'fallback')
    expect(parsed.name).toBe('fallback')
  })

  it('throws on malformed YAML', () => {
    expect(() =>
      parseSkillMarkdown(['---', 'name: [unclosed', '---', 'Body'].join('\n'), 'fallback'),
    ).toThrow(SkillParseError)
  })

  it('rejects a non-mapping frontmatter', () => {
    expect(() => parseSkillMarkdown(['---', '- just', '- a list', '---', 'Body'].join('\n'), 'fallback')).toThrow(
      SkillParseError,
    )
  })
})
