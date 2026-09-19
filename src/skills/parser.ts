import { parse as parseYaml } from 'yaml'
import { SkillParseError } from './schema'

export interface ParsedSkill {
  name: string
  description: string
  instructions: string
  allowedTools: string[]
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function toAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

export function parseSkillMarkdown(markdown: string, fallbackName: string): ParsedSkill {
  const match = FRONTMATTER.exec(markdown)
  if (!match) {
    return {
      name: fallbackName,
      description: '',
      instructions: markdown.trim(),
      allowedTools: [],
    }
  }

  let frontmatter: unknown
  try {
    frontmatter = parseYaml(match[1])
  } catch (cause) {
    throw new SkillParseError('The skill frontmatter is not valid YAML.', { cause })
  }
  if (frontmatter !== null && frontmatter !== undefined && typeof frontmatter !== 'object') {
    throw new SkillParseError('The skill frontmatter must be a mapping.')
  }
  if (Array.isArray(frontmatter)) {
    throw new SkillParseError('The skill frontmatter must be a mapping.')
  }

  const fields = (frontmatter ?? {}) as Record<string, unknown>
  const rawName = fields.name
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : fallbackName
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''

  return {
    name,
    description,
    instructions: markdown.slice(match[0].length).trim(),
    allowedTools: toAllowedTools(fields['allowed-tools'] ?? fields.allowedTools),
  }
}
