import type { LanguageModel } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import { createPlanToolProvider } from '../tools/builtin/plan'
import { createSkillManagementProvider } from '../tools/builtin/skill-management'
import { createSkillToolProvider } from '../tools/builtin/skills'
import { createToolManagementProvider } from '../tools/builtin/tool-management'
import { workspaceToolProvider } from '../tools/builtin/workspace'
import type { ToolDefinition, ToolProvider } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { createToolApproval } from './approval'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import type { WorkspaceFs } from '../workspace/fs'
import { createInlineSearchRunner } from '../workspace/search-runner'
import { createEngine } from './engine'
import type { EngineDeps, ThreadStore } from './engine'
import { useChatStore } from './store'
import { defaultThreadConfig } from './types'
import type { ChatThread } from './types'

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | {
      type: 'finish'
      usage: Usage
      finishReason: { unified: 'stop' | 'tool-calls'; raw: string | undefined }
    }

type Usage = {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
}

const usage: Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function toolStep(id: string, toolName: string, input: unknown): Chunk[] {
  const text = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: text },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: text },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
  ]
}

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ]
}

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }

function memoryStore(): ThreadStore {
  const threads = new Map<string, ChatThread>()
  return {
    loadThread: async (id) => threads.get(id) ?? null,
    saveThread: async (thread) => {
      threads.set(thread.id, thread)
    },
    listThreads: async () => [],
    deleteThread: async (id) => {
      threads.delete(id)
    },
  }
}

describe('harness end-to-end acceptance turn', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('composes search, read, edit, plan, and the skill index in one turn', async () => {
    const fake = createFakeWorkspace({ 'a.txt': 'TODO: fix\nsecond line' })
    const holder: { fs?: WorkspaceFs } = {}
    const searchRunner = createInlineSearchRunner({
      list: (path, options) => (holder.fs as WorkspaceFs).list(path, options),
      readFile: (path) => (holder.fs as WorkspaceFs).readFile(path),
    })
    const workspace = createWorkspaceFs(fake.handle, { searchRunner })
    holder.fs = workspace

    const skillRegistry = new SkillRegistry(skillStore)
    skillRegistry.resolve = (() => [
      {
        id: 's1',
        name: 'Skill One',
        description: 'SKILL_DESC',
        instructions: 'SKILL_BODY_MARKER',
        source: 'vault' as const,
        allowedTools: [],
      },
    ]) as typeof skillRegistry.resolve
    skillRegistry.toolNamesFor = (() => undefined) as typeof skillRegistry.toolNamesFor

    const registry = new ToolRegistry()
    registry.registerProvider(workspaceToolProvider)
    registry.registerProvider(createPlanToolProvider())
    registry.registerProvider(createSkillToolProvider({ isEnabled: () => true }))

    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'search', { pattern: 'TODO' })) },
        { stream: streamOf(toolStep('c2', 'read_file', { path: 'a.txt' })) },
        {
          stream: streamOf(
            toolStep('c3', 'edit_file', {
              path: 'a.txt',
              old_string: 'TODO: fix',
              new_string: 'DONE: fix',
            }),
          ),
        },
        { stream: streamOf(toolStep('c4', 'update_plan', { items: [{ text: 'Fix a.txt' }] })) },
        { stream: streamOf(textStep('t5', 'all done')) },
      ],
    })

    const store = memoryStore()
    const deps: EngineDeps = {
      getSettings: () => defaultSettings(),
      skillRegistry,
      toolRegistry: registry,
      threadStore: store,
      workspace,
      modelFactory: () => model as unknown as LanguageModel,
    }
    const engine = createEngine(deps)
    const thread: ChatThread = {
      id: 'th1',
      title: 'E2E',
      messages: [],
      config: defaultThreadConfig('p1', 'm1'),
      mode: 'god',
      createdAt: 1,
      updatedAt: 1,
    }
    useChatStore.getState().setThread(thread)

    await engine.sendTurn('th1', 'update the config and track it')

    const messages = useChatStore.getState().threads.th1.messages
    const toolParts = messages.flatMap((message) =>
      message.parts.filter((part) => part.type.startsWith('tool-')),
    ) as Array<{ state?: string; output?: { ok?: boolean } }>
    expect(toolParts).toHaveLength(4)
    for (const part of toolParts) {
      expect(part.state).toBe('output-available')
      expect(part.output?.ok).toBe(true)
    }

    await expect(workspace.readFile('a.txt')).resolves.toBe('DONE: fix\nsecond line')
    expect(useChatStore.getState().threads.th1.plan).toEqual([
      { id: 'p1', text: 'Fix a.txt', status: 'pending' },
    ])
    expect((await store.loadThread('th1'))?.plan).toHaveLength(1)

    const names = (model.doStreamCalls[0]?.tools ?? []).map(
      (entry) => (entry as { name?: string }).name ?? '',
    )
    for (const expected of ['search', 'read_file', 'edit_file', 'update_plan', 'load_skill']) {
      expect(names, expected).toContain(expected)
    }

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? [])
    expect(prompt).toContain('SKILL_DESC')
    expect(prompt).not.toContain('SKILL_BODY_MARKER')
  })
})

function memoryToolStore() {
  const rows = new Map<string, ToolDefinition>()
  return {
    rows,
    save: async (definition: ToolDefinition) => {
      rows.set(definition.name, definition)
    },
    remove: async (name: string) => {
      rows.delete(name)
    },
    list: async () => [...rows.values()],
  }
}

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

describe('harness self-management turn', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  function buildEngine(
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    model: MockLanguageModelV4,
    config = defaultThreadConfig('p1', 'm1'),
  ) {
    const deps: EngineDeps = {
      getSettings: () => defaultSettings(),
      skillRegistry,
      toolRegistry,
      threadStore: memoryStore(),
      modelFactory: () => model as unknown as LanguageModel,
    }
    const engine = createEngine(deps)
    const thread: ChatThread = {
      id: 'th1',
      title: 'Self-management',
      messages: [],
      config,
      mode: 'god',
      createdAt: 1,
      updatedAt: 1,
    }
    useChatStore.getState().setThread(thread)
    return engine
  }

  it('creates a vault skill and a user tool from model tool calls', async () => {
    const skillStoreImpl: SkillStore = {
      save: async () => {},
      remove: async () => {},
      list: async () => [],
    }
    const skillRegistry = new SkillRegistry(skillStoreImpl)
    const toolStoreImpl = memoryToolStore()
    const toolRegistry = new ToolRegistry(toolStoreImpl)
    toolRegistry.registerProvider(createSkillManagementProvider())
    toolRegistry.registerProvider(createToolManagementProvider())

    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: streamOf(
            toolStep('c1', 'create_skill', {
              id: 'made',
              name: 'Made',
              instructions: 'Body',
            }),
          ),
        },
        {
          stream: streamOf(
            toolStep('c2', 'create_tool', {
              kind: 'http',
              name: 'fetch_made',
              description: 'Made tool',
              inputSchema: { type: 'object' },
              request: {
                method: 'GET',
                url: 'https://api.example.com/x',
                allowedOrigins: ['https://api.example.com'],
              },
            }),
          ),
        },
        { stream: streamOf(textStep('t3', 'done')) },
      ],
    })

    await buildEngine(toolRegistry, skillRegistry, model).sendTurn('th1', 'manage the harness')

    const toolParts = useChatStore
      .getState()
      .threads.th1.messages.flatMap((message) =>
        message.parts.filter((part) => part.type.startsWith('tool-')),
      ) as Array<{ state?: string; output?: { ok?: boolean } }>
    expect(toolParts).toHaveLength(2)
    for (const part of toolParts) {
      expect(part.state).toBe('output-available')
      expect(part.output?.ok).toBe(true)
    }

    expect(skillRegistry.get({ id: 'made', source: 'vault' })?.instructions).toBe('Body')
    expect(skillRegistry.isEnabled({ id: 'made', source: 'vault' })).toBe(false)
    expect(toolRegistry.list()).toEqual([
      expect.objectContaining({ name: 'fetch_made', kind: 'http', enabled: false }),
    ])
  })

  it('gates the mutation tools and omits the list tools from the approval map', () => {
    const tools = [
      { name: 'create_skill' },
      { name: 'create_tool' },
      { name: 'list_skills' },
      { name: 'list_user_tools' },
    ]
    expect(createToolApproval('editing', { tools: {} }, tools)).toEqual({
      create_skill: 'user-approval',
      create_tool: 'user-approval',
    })
    expect(createToolApproval('god', { tools: {} }, tools)).toEqual({
      create_skill: 'approved',
      create_tool: 'approved',
    })
  })

  it('excludes the management tools when an enabled skill narrows the pool', async () => {
    const skillStoreImpl: SkillStore = {
      save: async () => {},
      remove: async () => {},
      list: async () => [],
    }
    const skillRegistry = new SkillRegistry(skillStoreImpl)
    skillRegistry.register(
      {
        id: 'narrow',
        name: 'Narrow',
        description: 'Only reads files.',
        instructions: 'Read only.',
        allowedTools: ['read_file'],
        source: 'vault',
      },
      { enabled: true },
    )
    const toolRegistry = new ToolRegistry(memoryToolStore())
    toolRegistry.registerProvider(stubProvider(['read_file']))
    toolRegistry.registerProvider(createSkillManagementProvider())
    toolRegistry.registerProvider(createToolManagementProvider())

    const model = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('t1', 'ok')) }] })
    const config = {
      ...defaultThreadConfig('p1', 'm1'),
      enabledSkills: [{ id: 'narrow', source: 'vault' as const }],
    }
    await buildEngine(toolRegistry, skillRegistry, model, config).sendTurn('th1', 'go')

    const names = (model.doStreamCalls[0]?.tools ?? []).map(
      (entry) => (entry as { name?: string }).name ?? '',
    )
    expect(names).toEqual(['read_file'])
    expect(names).not.toContain('list_skills')
    expect(names).not.toContain('create_skill')
  })
})
