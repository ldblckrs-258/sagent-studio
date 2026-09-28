import { jsonSchema, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { resolveAgentToolNames } from './toolset'
import type { AgentParentContext, AgentRequest } from './types'

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }

const TOOL_NAMES = [
  'read_file',
  'write_file',
  'remove',
  'run_python',
  'change_mode',
  'update_plan',
  'restore',
  'spawn_agent',
  'stop_agent',
  'read_agent',
  'load_skill',
  'search_skills',
  'read_tool_guide',
]

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

function build(options: { allowedTools?: string[]; enabled?: boolean } = {}) {
  const toolRegistry = new ToolRegistry()
  toolRegistry.registerProvider(stubProvider(TOOL_NAMES))
  const skillRegistry = new SkillRegistry(skillStore)
  skillRegistry.register(
    {
      id: 'narrow',
      name: 'Narrow',
      description: '',
      instructions: 'Only some tools.',
      allowedTools: options.allowedTools ?? ['read_file'],
      source: 'vault',
    },
    { enabled: options.enabled ?? true },
  )
  return { toolRegistry, skillRegistry }
}

function parent(mode: AgentParentContext['mode'] = 'editing'): AgentParentContext {
  return {
    parentThreadId: 'th1',
    mode,
    toolNames: TOOL_NAMES,
    providerId: 'p1',
    modelId: 'm1',
  }
}

function request(patch: Partial<AgentRequest> = {}): AgentRequest {
  return { prompt: 'do it', mode: 'editing', tier: 'medium', ...patch }
}

describe('resolveAgentToolNames', () => {
  it('clamps the requested mode to the parent mode and drops above-ceiling tools', () => {
    const { toolRegistry, skillRegistry } = build()
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent('read_only'),
      request: request({ mode: 'god' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mode).toBe('read_only')
    expect(result.names).toContain('read_file')
    expect(result.names).not.toContain('write_file')
    expect(result.names).not.toContain('run_python')
  })

  it('subtracts blocked tools even when a skill names them', () => {
    const { toolRegistry, skillRegistry } = build({
      allowedTools: [
        'read_file',
        'change_mode',
        'update_plan',
        'restore',
        'spawn_agent',
        'stop_agent',
        'read_agent',
      ],
    })
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent('god'),
      request: request({ mode: 'god', skills: ['narrow'] }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.names).toContain('read_file')
    for (const blocked of [
      'change_mode',
      'update_plan',
      'restore',
      'spawn_agent',
      'stop_agent',
      'read_agent',
    ]) {
      expect(result.names).not.toContain(blocked)
    }
  })

  it('lets a sub-agent recall memories but never write them', () => {
    const memoryTools = ['remember', 'update_memory', 'forget', 'recall_memory']
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerProvider(stubProvider(['read_file', ...memoryTools]))
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry: new SkillRegistry(skillStore),
      ports: {} as ToolRuntimePorts,
      parent: { ...parent('god'), toolNames: ['read_file', ...memoryTools] },
      request: request({ mode: 'god' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.names.filter((name) => memoryTools.includes(name))).toEqual(['recall_memory'])
  })

  it('subtracts excludeTools', () => {
    const { toolRegistry, skillRegistry } = build()
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent('editing'),
      request: request({ excludeTools: ['read_file'] }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.names).not.toContain('read_file')
  })

  it('fails when a requested skill does not resolve', () => {
    const { toolRegistry, skillRegistry } = build()
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent(),
      request: request({ skills: ['missing'] }),
    })
    expect(result.ok).toBe(false)
  })

  it('fails when a requested skill exists but is disabled', () => {
    const { toolRegistry, skillRegistry } = build({ enabled: false })
    const result = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent(),
      request: request({ skills: ['narrow'] }),
    })
    expect(result.ok).toBe(false)
  })
})

describe('resolveAgentToolNames with MCP tools', () => {
  it('lets a sub-agent inherit an MCP tool from the parent pool but never above its mode ceiling', () => {
    const { toolRegistry, skillRegistry } = build({ enabled: false })
    toolRegistry.setExternalTools('mcp:a', [
      {
        name: 'mcp_linear_list_issues',
        kind: 'mcp',
        create: () =>
          tool({ description: 'mcp', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ok' }),
      },
    ])
    const withMcp = { ...parent('editing'), toolNames: [...TOOL_NAMES, 'mcp_linear_list_issues'] }
    const editing = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: withMcp,
      request: request({ mode: 'editing' }),
    })
    expect(editing.ok && editing.names).toContain('mcp_linear_list_issues')

    const readOnly = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: withMcp,
      request: request({ mode: 'read_only' }),
    })
    expect(readOnly.ok && readOnly.names).not.toContain('mcp_linear_list_issues')

    const notInParent = resolveAgentToolNames({
      toolRegistry,
      skillRegistry,
      ports: {} as ToolRuntimePorts,
      parent: parent('editing'),
      request: request({ mode: 'editing' }),
    })
    expect(notInParent.ok && notInParent.names).not.toContain('mcp_linear_list_issues')
  })
})
