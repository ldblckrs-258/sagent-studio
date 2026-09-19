import type { SkillRef } from '../chat/types'

export interface SkillManifest {
  id: string
  name: string
  description: string
  instructions: string
  allowedTools: string[]
  source: 'vault' | 'workspace'
  path?: string
}

export class SkillError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillError'
  }
}

export class SkillParseError extends SkillError {
  constructor(message = 'The skill could not be parsed.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillParseError'
  }
}

export function skillKey(ref: SkillRef): string {
  return `${ref.source}:${ref.id}`
}

export function skillRefOf(manifest: SkillManifest): SkillRef {
  return { id: manifest.id, source: manifest.source }
}

export function isSkillManifest(value: unknown): value is SkillManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return false
  if (typeof candidate.description !== 'string') return false
  if (typeof candidate.instructions !== 'string') return false
  if (candidate.source !== 'vault' && candidate.source !== 'workspace') return false
  if (!Array.isArray(candidate.allowedTools)) return false
  return candidate.allowedTools.every((tool) => typeof tool === 'string')
}
