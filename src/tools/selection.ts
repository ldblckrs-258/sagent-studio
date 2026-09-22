import type { ResolvedSkill } from '../chat/context'
import type { SkillRef } from '../chat/types'
import type { SkillRegistry } from '../skills/registry'
import type { ToolRegistry } from './registry'
import type { ToolRuntimePorts } from './types'

/** Always kept available when skills are enabled, even under `allowedTools` narrowing. */
export const SKILL_INDEX_TOOLS = ['load_skill', 'search_skills'] as const

/** Always kept available so a run can read a topic guide. */
export const GUIDE_TOOLS = ['read_tool_guide'] as const

export interface ResolveRunToolNamesInput {
  toolRegistry: ToolRegistry
  skillRegistry: SkillRegistry
  ports: ToolRuntimePorts
  /** The refs whose skills should narrow the toolset. */
  enabledSkills: readonly SkillRef[]
  /** The already-resolved skills for `enabledSkills`; drives the index-tool union. */
  resolvedSkills: readonly ResolvedSkill[]
  /**
   * Restrict the result to these names. Defaults to every available tool, which
   * is the parent conversation's behavior when no skill narrows the set.
   */
  pool?: ReadonlySet<string>
  /** Names removed after the skill union, so a skill cannot re-add them. */
  blocked?: readonly string[]
}

/**
 * The single tool-name resolver shared by the parent run and a delegated agent.
 * It computes the available pool, narrows it by the enabled skills, unions the
 * always-kept skill-index and guide tools, and subtracts `blocked` **last** so a
 * skill's `allowedTools` can never re-add a blocked tool.
 */
export function resolveRunToolNames(input: ResolveRunToolNamesInput): string[] {
  const pool =
    input.pool ?? new Set(input.toolRegistry.availableNames(input.ports))
  const narrowed = input.skillRegistry.toolNamesFor(input.enabledSkills, pool)
  const kept = [
    ...(input.resolvedSkills.length > 0 ? SKILL_INDEX_TOOLS : []),
    ...GUIDE_TOOLS,
  ] as readonly string[]
  const base =
    narrowed === undefined
      ? [...pool]
      : [...new Set([...narrowed, ...kept.filter((name) => pool.has(name))])]
  const blocked = new Set(input.blocked ?? [])
  return base.filter((name) => !blocked.has(name)).sort()
}
