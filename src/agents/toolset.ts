import type { ResolvedSkill } from '../chat/context'
import type { ChatMode, SkillRef } from '../chat/types'
import type { SkillRegistry } from '../skills/registry'
import { clampMode, isWithinCeiling } from '../tools/approval'
import type { ToolGateDescriptor } from '../tools/approval'
import type { ToolRegistry } from '../tools/registry'
import { resolveRunToolNames } from '../tools/selection'
import type { ToolRuntimePorts } from '../tools/types'
import { BLOCKED_AGENT_TOOLS } from './types'
import type { AgentParentContext, AgentRequest } from './types'

export type AgentToolsetResolution =
  | { ok: true; mode: ChatMode; names: string[]; skills: ResolvedSkill[] }
  | { ok: false; message: string }

/**
 * Resolves the requested skill id to an enabled ref, preferring the vault copy
 * when the same id exists in both sources. Returns null when the id is unknown
 * or its skill is not enabled; the caller must treat that as a hard error rather
 * than widening the toolset.
 */
function resolveSkillRef(registry: SkillRegistry, id: string): SkillRef | null {
  const matches = registry.list().filter((manifest) => manifest.id === id)
  if (matches.length === 0) return null
  const source = matches.some((manifest) => manifest.source === 'vault') ? 'vault' : 'workspace'
  const ref: SkillRef = { id, source }
  return registry.isEnabled(ref) ? ref : null
}

function descriptorFor(toolRegistry: ToolRegistry, name: string): ToolGateDescriptor {
  const kind = toolRegistry.userToolKind(name)
  return kind ? { name, kind } : { name }
}

/**
 * The exact toolset a delegated agent may use. The requested mode is clamped to
 * the parent's, at most the parent's tool names are eligible, every requested
 * skill must resolve and be enabled, above-ceiling tools are excluded, and the
 * blocked and excluded names are removed last so a skill cannot re-add them.
 */
export function resolveAgentToolNames(input: {
  toolRegistry: ToolRegistry
  skillRegistry: SkillRegistry
  ports: ToolRuntimePorts
  parent: AgentParentContext
  request: AgentRequest
}): AgentToolsetResolution {
  const mode = clampMode(input.parent.mode, input.request.mode)

  const requestedRefs: SkillRef[] = []
  for (const id of input.request.skills ?? []) {
    const ref = resolveSkillRef(input.skillRegistry, id)
    if (!ref) return { ok: false, message: `No enabled skill is named "${id}".` }
    requestedRefs.push(ref)
  }

  const excluded = new Set(input.request.excludeTools ?? [])
  const pool = new Set(
    input.parent.toolNames.filter(
      (name) =>
        !excluded.has(name) &&
        isWithinCeiling(mode, descriptorFor(input.toolRegistry, name)),
    ),
  )

  const resolvedSkills = input.skillRegistry.resolve(requestedRefs)
  const names = resolveRunToolNames({
    toolRegistry: input.toolRegistry,
    skillRegistry: input.skillRegistry,
    ports: input.ports,
    enabledSkills: requestedRefs,
    resolvedSkills,
    pool,
    blocked: BLOCKED_AGENT_TOOLS,
  })

  return { ok: true, mode, names, skills: resolvedSkills }
}
