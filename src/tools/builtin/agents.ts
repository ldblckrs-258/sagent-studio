import { jsonSchema, tool } from 'ai'
import { tierForMode } from '../../ai/model-tier'
import type { AgentRequest } from '../../agents/types'
import type { ChatMode } from '../../chat/types'
import type { ModelTier } from '../../vault/settings'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['spawn_agent'] as const
const MODES: readonly ChatMode[] = ['read_only', 'editing', 'god']
const TIERS: readonly ModelTier[] = ['cheap', 'medium', 'high', 'max']

interface ParsedInput {
  prompt: string
  mode: ChatMode
  tier: ModelTier
  skills?: string[]
  excludeTools?: string[]
  background: boolean
  label?: string
}

/** Reads an optional string array; `null` means present but malformed. */
function readStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === 'string')) return null
  return value as string[]
}

function parseInput(input: unknown): ParsedInput | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (prompt === '') return null

  const mode =
    raw.mode === undefined
      ? 'read_only'
      : (MODES as readonly unknown[]).includes(raw.mode)
        ? (raw.mode as ChatMode)
        : null
  if (mode === null) return null

  const tier =
    raw.tier === undefined
      ? tierForMode(mode)
      : (TIERS as readonly unknown[]).includes(raw.tier)
        ? (raw.tier as ModelTier)
        : null
  if (tier === null) return null

  const skills = readStringArray(raw.skills)
  if (skills === null) return null
  const excludeTools = readStringArray(raw.excludeTools)
  if (excludeTools === null) return null

  const background =
    raw.background === undefined ? false : raw.background === true ? true : null
  if (background === null) return null
  if (raw.label !== undefined && typeof raw.label !== 'string') return null

  return {
    prompt,
    mode,
    tier,
    background,
    ...(skills ? { skills } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  }
}

/**
 * Delegates a bounded task to a nested agent. The requested mode is clamped to
 * the conversation's own mode, the sub-agent may only draw from the parent's
 * tools (minus a fixed block list), and its output is untrusted data.
 */
export function createAgentsToolProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => true,
    create(name, ports) {
      if (name !== 'spawn_agent') throw new ToolNotFoundError(name)
      return tool({
        description:
          'Delegate a bounded task to a nested agent, either inline (awaited) or detached in the background. The agent can only use a subset of your own tools and its permission mode is capped at the conversation mode. Awaited results return here; a background run reports back as a notice. Read the agents tool guide for when to delegate.',
        inputSchema: jsonSchema<{
          prompt: string
          mode?: ChatMode
          tier?: ModelTier
          skills?: string[]
          excludeTools?: string[]
          background?: boolean
          label?: string
        }>({
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The complete, self-contained task for the delegated agent.',
            },
            mode: {
              type: 'string',
              enum: [...MODES],
              description: 'Requested permission mode; clamped to the conversation mode.',
            },
            tier: {
              type: 'string',
              enum: [...TIERS],
              description: 'Model tier; defaults from the mode. Use max only for advisory work.',
            },
            skills: {
              type: 'array',
              items: { type: 'string' },
              description: 'Skill ids to activate for the delegated agent.',
            },
            excludeTools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to withhold from the delegated agent.',
            },
            background: {
              type: 'boolean',
              description: 'Run detached and report back as a notice instead of returning inline.',
            },
            label: { type: 'string', description: 'A short label for the Agents panel.' },
          },
          required: ['prompt'],
        } as Parameters<typeof jsonSchema>[0]),
        execute: wrapToolExecute(async (input) => {
          const port = ports.agents
          if (!port) throw new ToolRuntimeUnavailableError(name)
          const parsed = parseInput(input)
          if (!parsed) {
            return toolFail(
              'invalid_input',
              'spawn_agent needs a non-empty prompt and well-formed mode, tier, skills, excludeTools, background, and label fields.',
            )
          }
          const request: AgentRequest = {
            prompt: parsed.prompt,
            mode: parsed.mode,
            tier: parsed.tier,
            background: parsed.background,
            ...(parsed.skills ? { skills: parsed.skills } : {}),
            ...(parsed.excludeTools ? { excludeTools: parsed.excludeTools } : {}),
            ...(parsed.label ? { label: parsed.label } : {}),
          }
          const outcome = await port.spawn(request, {
            background: parsed.background,
            ...(parsed.label ? { label: parsed.label } : {}),
          })
          switch (outcome.status) {
            case 'completed': {
              // A run that ended `error`/`aborted`/`invalid_input` is a failed
              // delegation, not a success with empty text.
              if (outcome.result.status !== 'completed') {
                const code =
                  outcome.result.status === 'invalid_input' ||
                  outcome.result.status === 'denied' ||
                  outcome.result.status === 'limit_exceeded'
                    ? outcome.result.status
                    : 'runtime_error'
                return toolFail(
                  code,
                  outcome.result.error ?? `The delegated agent ${outcome.result.status}.`,
                  { value: { runStatus: outcome.result.status } },
                )
              }
              return toolOk({
                status: 'completed',
                ...(outcome.label !== undefined ? { label: outcome.label } : {}),
                result: outcome.result.text,
                runStatus: outcome.result.status,
                toolCalls: outcome.result.toolCalls,
                ...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
                ...(outcome.result.truncated ? { truncated: true } : {}),
                untrusted: true,
              })
            }
            case 'running':
              return toolOk({
                status: 'running',
                runId: outcome.runId,
                ...(outcome.label !== undefined ? { label: outcome.label } : {}),
              })
            case 'limit_exceeded':
              return toolFail('limit_exceeded', outcome.message)
            case 'error':
              return toolFail('runtime_error', outcome.message)
          }
        }),
      })
    },
  }
}
