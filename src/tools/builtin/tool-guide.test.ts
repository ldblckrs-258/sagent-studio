import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { ToolRegistry } from '../registry'
import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES } from '../http'
import { TOOL_NAME_PATTERN } from '../types'
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
} from '../../vault/settings'
import type { CodeRunner } from '../../sandbox/types'
import { createAgentsToolProvider } from './agents'
import { createCodeToolProvider } from './code'
import { createHistoryToolProvider } from './history'
import { createMemoryToolProvider } from './memory'
import { MCP_RESOURCE_TEXT_MAX, createMcpResourceToolProvider } from './mcp-resources'
import { MCP_RESOURCE_LIST_MAX } from '../../mcp/resource-port'
import { MCP_RESULT_TEXT_MAX } from '../../mcp/tool-bridge'
import { createRagToolProvider } from './rag'
import { createSandboxControlProvider } from './sandbox-control'
import { createSkillManagementProvider } from './skill-management'
import { createSkillToolProvider } from './skills'
import { createTerminalToolProvider } from './terminal'
import { createToolManagementProvider } from './tool-management'
import { workspaceToolProvider } from './workspace'
import { TOOL_GUIDE_TOPICS, createToolGuideProvider, toolGuideHint } from './tool-guide'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

async function guideFor(topic: string): Promise<string> {
  const result = (await executor(toolSet(), 'read_tool_guide')({ topic }, CALL)) as {
    value: { guide: string }
  }
  return result.value.guide
}

const noopRunner: CodeRunner = {
  run: async () => ({ stdout: '', stderr: '', result: null }),
}

const COVERED_BY_PROVIDERS = new Set(
  [
    workspaceToolProvider,
    createCodeToolProvider({
      getRunners: () => ({ js: noopRunner, python: noopRunner }),
      isEnabled: () => true,
    }),
    createSandboxControlProvider({ isEnabled: () => true, getPort: () => undefined }),
    createHistoryToolProvider(),
    createSkillToolProvider({ isEnabled: () => true }),
    createSkillManagementProvider(),
    createToolManagementProvider(),
    createToolGuideProvider(),
    createRagToolProvider(() => undefined),
    createAgentsToolProvider(),
    createMemoryToolProvider(),
    createMcpResourceToolProvider(),
    createTerminalToolProvider(),
  ].flatMap((provider) => [...provider.names]),
)

function toolSet(): ToolSet {
  const registry = new ToolRegistry({
    save: async () => undefined,
    remove: async () => undefined,
    list: async () => [],
  })
  registry.registerProvider(createToolGuideProvider())
  return registry.buildToolSet(['read_tool_guide'], {})
}

describe('read_tool_guide', () => {
  it('is available without any runtime port', () => {
    const registry = new ToolRegistry({
      save: async () => undefined,
      remove: async () => undefined,
      list: async () => [],
    })
    registry.registerProvider(createToolGuideProvider())
    expect(registry.availableNames({})).toContain('read_tool_guide')
  })

  it('lists every topic when no argument is given', async () => {
    const result = (await executor(toolSet(), 'read_tool_guide')({}, CALL)) as {
      ok: boolean
      value: { topics: { topic: string; summary: string; covers: string[] }[] }
    }
    expect(result.ok).toBe(true)
    expect(result.value.topics.map((entry) => entry.topic)).toEqual([...TOOL_GUIDE_TOPICS])
    for (const entry of result.value.topics) {
      expect(entry.summary.length).toBeGreaterThan(0)
      expect(entry.covers.length).toBeGreaterThan(0)
    }
  })

  it('returns a non-empty guide for every topic', async () => {
    const execute = executor(toolSet(), 'read_tool_guide')
    for (const topic of TOOL_GUIDE_TOPICS) {
      const result = (await execute({ topic }, CALL)) as {
        ok: boolean
        value: { topic: string; guide: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value.topic).toBe(topic)
      expect(result.value.guide.length).toBeGreaterThan(100)
    }
  })

  it('resolves a tool name onto the topic that covers it', async () => {
    const execute = executor(toolSet(), 'read_tool_guide')
    const cases: [string, string][] = [
      ['create_tool', 'custom_tools'],
      ['run_python', 'sandbox'],
      ['edit_file', 'workspace_edit'],
      ['restore', 'checkpoints'],
      ['load_skill', 'skills'],
      ['  Sandbox  ', 'sandbox'],
    ]
    for (const [requested, expected] of cases) {
      const result = (await execute({ topic: requested }, CALL)) as {
        value: { topic: string }
      }
      expect(result.value.topic).toBe(expected)
    }
  })

  it('fails with the topic list when nothing matches', async () => {
    const result = (await executor(toolSet(), 'read_tool_guide')({ topic: 'nope' }, CALL)) as {
      ok: boolean
      code: string
      hint: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not_found')
    for (const topic of TOOL_GUIDE_TOPICS) expect(result.hint).toContain(topic)
  })

  it('quotes the limits its topics actually enforce', async () => {
    const customTools = await guideFor('custom_tools')
    expect(customTools).toContain(TOOL_NAME_PATTERN.source)
    expect(customTools).toContain(String(DEFAULT_TIMEOUT_MS))
    expect(customTools).toContain(String(MAX_RESPONSE_BYTES))

    const sandbox = await guideFor('sandbox')
    expect(sandbox).toContain(String(DEFAULT_SANDBOX_JS_TIMEOUT_MS))
    expect(sandbox).toContain(String(DEFAULT_SANDBOX_PY_TIMEOUT_MS))
    expect(sandbox).toContain(String(DEFAULT_SANDBOX_IDLE_TIMEOUT_MS / 60_000))

    const mcp = await guideFor('mcp')
    expect(mcp).toContain(MCP_RESOURCE_TEXT_MAX.toLocaleString('en-US'))
    expect(mcp).toContain(MCP_RESULT_TEXT_MAX.toLocaleString('en-US'))
    expect(mcp).toContain(`up to ${MCP_RESOURCE_LIST_MAX} per server`)
  })

  it('only covers tool names the registry knows', async () => {
    const index = (await executor(toolSet(), 'read_tool_guide')({}, CALL)) as {
      value: { topics: { covers: string[] }[] }
    }
    for (const entry of index.value.topics) {
      for (const name of entry.covers) expect(COVERED_BY_PROVIDERS).toContain(name)
    }
  })

  it('points the failure hint at read_tool_guide', () => {
    expect(toolGuideHint('sandbox')).toContain('read_tool_guide')
    expect(toolGuideHint('sandbox')).toContain('sandbox')
  })
})
