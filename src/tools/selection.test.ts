import { jsonSchema, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from './registry'
import { resolveRunToolNames } from './selection'
import type { ToolProvider, ToolRuntimePorts } from './types'

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }

function stubProvider(names: string[]): ToolProvider {
  return {
    names,
    isAvailable: () => true,
    create: (name) =>
      tool({
        description: name,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => `${name}:ok`,
      }),
  }
}

const PROPERTY_TOOLS = [
  'read_file',
  'write_file',
  'search_skills',
  'load_skill',
  'read_tool_guide',
  'change_mode',
  'spawn_agent',
  'unrelated',
]

function registryWithSkills(allowedTools: string[]) {
  const registry = new ToolRegistry()
  registry.registerProvider(stubProvider(PROPERTY_TOOLS))
  const skillRegistry = new SkillRegistry(skillStore)
  skillRegistry.register(
    {
      id: 'narrow',
      name: 'Narrow',
      description: '',
      instructions: 'Do the thing.',
      allowedTools,
      source: 'vault',
    },
    { enabled: true },
  )
  return { registry, skillRegistry }
}

function resolve(
  registry: ToolRegistry,
  skillRegistry: SkillRegistry,
  blocked: readonly string[] = [],
) {
  return resolveRunToolNames({
    toolRegistry: registry,
    skillRegistry,
    ports: {} as ToolRuntimePorts,
    enabledSkills: [{ id: 'narrow', source: 'vault' }],
    resolvedSkills: skillRegistry.resolve([{ id: 'narrow', source: 'vault' }]),
    blocked,
  })
}

describe('resolveRunToolNames', () => {
  it('returns every available name when no skill narrows the pool', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(stubProvider(['a', 'b']))
    const skillRegistry = new SkillRegistry(skillStore)
    const names = resolveRunToolNames({
      toolRegistry: registry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      enabledSkills: [],
      resolvedSkills: [],
      blocked: [],
    })
    expect(names).toEqual(['a', 'b'])
  })

  it('unions the always-kept skill-index and guide tools into a narrowed set', () => {
    const { registry, skillRegistry } = registryWithSkills(['read_file'])
    expect(resolve(registry, skillRegistry)).toEqual([
      'load_skill',
      'read_file',
      'read_tool_guide',
      'search_skills',
    ])
  })

  it('subtracts the blocked names after the union, so a skill cannot re-add them', () => {
    const { registry, skillRegistry } = registryWithSkills([
      'read_file',
      'change_mode',
      'spawn_agent',
    ])
    const names = resolve(registry, skillRegistry, ['change_mode', 'spawn_agent'])
    expect(names).toContain('read_file')
    expect(names).not.toContain('change_mode')
    expect(names).not.toContain('spawn_agent')
  })

  it('honors an explicit pool instead of every available tool', () => {
    const { registry, skillRegistry } = registryWithSkills([])
    const names = resolveRunToolNames({
      toolRegistry: registry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      enabledSkills: [{ id: 'narrow', source: 'vault' }],
      resolvedSkills: skillRegistry.resolve([{ id: 'narrow', source: 'vault' }]),
      pool: new Set(['read_file', 'load_skill']),
      blocked: [],
    })
    expect(names).toEqual(['load_skill', 'read_file'])
  })
})
