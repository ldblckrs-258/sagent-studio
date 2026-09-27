import { parse as parseYaml } from 'yaml'
import { tierForMode } from '../ai/model-tier'
import type { ChatMode } from '../chat/types'
import type { ModelTier } from '../vault/settings'
import type { AgentRequest, AgentSpawnRequest } from './types'

export interface AgentProfile {
  id: string
  name: string
  description: string
  mode?: ChatMode
  tier?: ModelTier
  tools?: string[]
  excludeTools?: string[]
  skills?: string[]
  inheritInstructions?: boolean
  instructions: string
  source: 'builtin' | 'workspace'
  path?: string
}

export interface AgentProfileLoadError {
  path: string
  message: string
}

export interface AgentProfileSource {
  list(): Promise<{ profiles: AgentProfile[]; errors: AgentProfileLoadError[] }>
}

export class AgentProfileParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentProfileParseError'
  }
}

const MODES: readonly ChatMode[] = ['read_only', 'editing', 'god']
const TIERS: readonly ModelTier[] = ['cheap', 'medium', 'high', 'max']
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'explorer',
    name: 'Explorer',
    description: 'Read-only scout that locates and maps code and reports path:line evidence.',
    mode: 'read_only',
    tier: 'cheap',
    instructions:
      'You locate and map code. Search before you read, read only what answers the question, and report every finding with `path:line` evidence. Do not suggest fixes unless asked.',
    source: 'builtin',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only reviewer that reports findings by severity with file:line, a failure scenario, and a fix.',
    mode: 'read_only',
    tier: 'high',
    instructions:
      'You review code for correctness, regressions, and security. Report each finding with its severity (critical, major, minor), `file:line`, a concrete failure scenario, and a suggested fix, most severe first. Report nothing you have not verified in the code.',
    source: 'builtin',
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Read-only planner that produces phased steps, risks, and verification.',
    mode: 'read_only',
    tier: 'high',
    instructions:
      'You plan an implementation. Read the relevant code first, then produce ordered phases with the files each one touches, the risks, and how each phase is verified. Name assumptions explicitly.',
    source: 'builtin',
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'Editing agent that implements a bounded change, runs checks, and reports the diff.',
    mode: 'editing',
    tier: 'medium',
    instructions:
      'You implement one bounded change. Match the surrounding code style, change only what the task needs, run the available checks, and report the files you changed with a short summary of each diff.',
    source: 'builtin',
  },
]

function readList(fields: Record<string, unknown>, key: string): string[] | undefined {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.map((entry: string) => entry.trim()).filter((entry) => entry.length > 0)
  }
  throw new AgentProfileParseError(`"${key}" must be a list of names.`)
}

function readEnum<T extends string>(
  fields: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new AgentProfileParseError(`"${key}" must be one of ${allowed.join(', ')}.`)
}

function readText(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AgentProfileParseError(`"${key}" must be text.`)
  return value.trim()
}

export function parseAgentProfileMarkdown(
  markdown: string,
  fallbackId: string,
): Omit<AgentProfile, 'source' | 'path'> {
  const match = FRONTMATTER.exec(markdown)
  if (!match) {
    return { id: fallbackId, name: fallbackId, description: '', instructions: markdown.trim() }
  }
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(match[1])
  } catch (cause) {
    throw new AgentProfileParseError('The frontmatter is not valid YAML.', { cause })
  }
  if (frontmatter !== null && frontmatter !== undefined) {
    if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
      throw new AgentProfileParseError('The frontmatter must be a mapping.')
    }
  }
  const fields = (frontmatter ?? {}) as Record<string, unknown>
  const inherit = fields['inherit-instructions']
  if (inherit !== undefined && inherit !== null && typeof inherit !== 'boolean') {
    throw new AgentProfileParseError('"inherit-instructions" must be true or false.')
  }
  const name = readText(fields, 'name')
  const mode = readEnum(fields, 'mode', MODES)
  const tier = readEnum(fields, 'tier', TIERS)
  const tools = readList(fields, 'tools')
  const excludeTools = readList(fields, 'exclude-tools')
  const skills = readList(fields, 'skills')
  return {
    id: fallbackId,
    name: name !== undefined && name.length > 0 ? name : fallbackId,
    description: readText(fields, 'description') ?? '',
    ...(mode !== undefined ? { mode } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(excludeTools !== undefined ? { excludeTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(inherit === true ? { inheritInstructions: true } : {}),
    instructions: markdown.slice(match[0].length).trim(),
  }
}

export class AgentProfileRegistry {
  private workspace: AgentProfile[] = []
  private errors: AgentProfileLoadError[] = []
  private readonly listeners = new Set<() => void>()
  private version = 0
  private generation = 0
  private pending: Promise<void> = Promise.resolve()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion(): number {
    return this.version
  }

  private notify(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  list(): AgentProfile[] {
    const byId = new Map<string, AgentProfile>()
    for (const profile of BUILTIN_AGENT_PROFILES) byId.set(profile.id, profile)
    for (const profile of this.workspace) byId.set(profile.id, profile)
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): AgentProfile | undefined {
    return this.list().find((profile) => profile.id === id)
  }

  loadErrors(): AgentProfileLoadError[] {
    return [...this.errors]
  }

  load(source: AgentProfileSource | null): Promise<void> {
    const run = this.apply(source, ++this.generation)
    this.pending = run
    return run
  }

  private async apply(source: AgentProfileSource | null, generation: number): Promise<void> {
    let profiles: AgentProfile[] = []
    let errors: AgentProfileLoadError[] = []
    if (source) {
      try {
        const loaded = await source.list()
        profiles = loaded.profiles
        errors = loaded.errors
      } catch (error) {
        errors = [{ path: '.agents/agents', message: error instanceof Error ? error.message : String(error) }]
      }
    }
    if (generation !== this.generation) return this.pending
    this.workspace = profiles
    this.errors = errors
    this.notify()
  }
}

function union(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] {
  return [...new Set([...(first ?? []), ...(second ?? [])])]
}

export function applyAgentProfile(
  request: AgentSpawnRequest,
  profile: AgentProfile | undefined,
): AgentRequest {
  const mode = request.mode ?? profile?.mode ?? 'read_only'
  const tier = request.tier ?? profile?.tier ?? tierForMode(mode)
  const skills = union(profile?.skills, request.skills)
  const excludeTools = union(profile?.excludeTools, request.excludeTools)
  const allowTools = request.allowTools ?? profile?.tools
  return {
    ...request,
    mode,
    tier,
    ...(skills.length > 0 ? { skills } : {}),
    ...(excludeTools.length > 0 ? { excludeTools } : {}),
    ...(allowTools !== undefined ? { allowTools } : {}),
    ...(profile ? { agent: profile.id } : {}),
  }
}
