import type { LanguageModel, UIMessage } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createEngine } from '../chat/engine'
import type { EngineDeps, ThreadStore } from '../chat/engine'
import { rehydrateThread } from '../chat/sanitize'
import { useChatStore } from '../chat/store'
import { defaultThreadConfig } from '../chat/types'
import type { ChatThread } from '../chat/types'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { createAgentsToolProvider } from '../tools/builtin/agents'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { deepMerge, defaultSettings } from '../vault/settings'
import type { Settings } from '../vault/settings'
import { createAgentRuntime } from './runtime'
import { AgentRunStore } from './store'

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; usage: Usage; finishReason: { unified: 'stop' | 'tool-calls'; raw: string | undefined } }

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

function provider(id: string): Settings['providers'][number] {
  return {
    id,
    label: id,
    kind: 'openai-compatible',
    baseURL: 'https://example.com/v1',
    apiKey: 'k',
    models: [{ id: 'm' }],
    defaultModel: 'm',
  }
}

function settingsWith(tiers: Record<string, { providerId: string; modelId: string }>): Settings {
  return deepMerge(defaultSettings(), {
    providers: [provider('parent'), provider('sub'), provider('oracle')],
    modelTiers: tiers,
  })
}

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

function recorderProvider(): ToolProvider {
  return {
    names: ['read_file'],
    isAvailable: () => true,
    create: (name) =>
      tool({
        description: name,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => 'file contents',
      }),
  }
}

function parentModel(background: boolean): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: streamOf(
          toolStep('c1', 'spawn_agent', {
            prompt: 'research the topic',
            mode: 'god',
            tier: 'cheap',
            ...(background ? { background: true } : {}),
          }),
        ),
      },
      { stream: streamOf(textStep('t2', 'parent done')) },
    ],
  })
}

function build(options: { settings: Settings; modelFactory: EngineDeps['modelFactory'] }) {
  const store = new AgentRunStore()
  const toolRegistry = new ToolRegistry()
  toolRegistry.registerProvider(recorderProvider())
  toolRegistry.registerProvider(createAgentsToolProvider())

  const deps: EngineDeps = {
    getSettings: () => options.settings,
    skillRegistry: new SkillRegistry(skillStore),
    toolRegistry,
    threadStore: memoryStore(),
    modelFactory: options.modelFactory,
    agentPortsFor: (context) => ({
      spawn: (request, spawnOptions) => runtime.spawn(context, request, spawnOptions),
    }),
  }
  const engine = createEngine(deps)

  const runtime = createAgentRuntime({
    getSettings: () => options.settings,
    skillRegistry: new SkillRegistry(skillStore),
    toolRegistry,
    store,
    ...(options.modelFactory ? { modelFactory: options.modelFactory } : {}),
    portsFor: () => ({}) as ToolRuntimePorts,
    onSettle: (run) => {
      if (run.result) engine.appendAgentNotice(run.parentThreadId, `Sub-agent finished: ${run.result.text}`, run.runId)
    },
  })
  return { engine, store }
}

function seed(): void {
  const thread: ChatThread = {
    id: 'th1',
    title: 'E2E',
    messages: [],
    config: defaultThreadConfig('parent', 'm1'),
    mode: 'god',
    createdAt: 1,
    updatedAt: 1,
  }
  useChatStore.getState().setThread(thread)
}

function agentSpawnParts(): Array<{ state?: string; output?: { value?: { status?: string; result?: string } } }> {
  return useChatStore
    .getState()
    .threads.th1.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === 'tool-spawn_agent'),
    ) as never
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('agent delegation end to end', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('runs a delegated agent inline and returns its result to the parent', async () => {
    const sub = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('s1', 'sub result')) }] })
    const parent = parentModel(false)
    const { engine } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: (_settings, providerId) =>
        (providerId === 'sub' ? sub : parent) as unknown as LanguageModel,
    })
    seed()

    await engine.sendTurn('th1', 'delegate this')

    const spawn = agentSpawnParts()[0]
    expect(spawn.state).toBe('output-available')
    expect(spawn.output?.value?.status).toBe('completed')
    expect(spawn.output?.value?.result).toContain('sub result')

    const notices = useChatStore
      .getState()
      .threads.th1.messages.filter((m: UIMessage) => (m.metadata as { agentNotice?: boolean })?.agentNotice)
    expect(notices).toHaveLength(0)
  })

  it('appends exactly one notice when a background agent settles', async () => {
    const sub = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('s1', 'background result')) }] })
    const parent = parentModel(true)
    const { engine } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: (_settings, providerId) =>
        (providerId === 'sub' ? sub : parent) as unknown as LanguageModel,
    })
    seed()

    await engine.sendTurn('th1', 'delegate in the background')

    const spawn = agentSpawnParts()[0]
    expect(spawn.output?.value?.status).toBe('running')

    await waitFor(() =>
      useChatStore
        .getState()
        .threads.th1.messages.some((m: UIMessage) => (m.metadata as { agentNotice?: boolean })?.agentNotice === true),
    )
    const notices = useChatStore
      .getState()
      .threads.th1.messages.filter((m: UIMessage) => (m.metadata as { agentNotice?: boolean })?.agentNotice)
    expect(notices).toHaveLength(1)
    expect(notices[0].parts.some((part) => part.type === 'text' && part.text.includes('background result'))).toBe(true)
  })

  it('uses the explicitly requested max tier', async () => {
    const oracle = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('o1', 'oracle reply')) }] })
    const sub = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('s1', 'cheap reply')) }] })
    const parent = new MockLanguageModelV4({
      doStream: [
        {
          stream: streamOf(
            toolStep('c1', 'spawn_agent', { prompt: 'advise me', mode: 'god', tier: 'max' }),
          ),
        },
        { stream: streamOf(textStep('t2', 'parent done')) },
      ],
    })
    const { engine } = build({
      settings: settingsWith({ max: { providerId: 'oracle', modelId: 'm' } }),
      modelFactory: (_settings, providerId) =>
        (providerId === 'oracle' ? oracle : providerId === 'sub' ? sub : parent) as unknown as LanguageModel,
    })
    seed()

    await engine.sendTurn('th1', 'advise')

    expect(oracle.doStreamCalls.length).toBeGreaterThan(0)
    expect(sub.doStreamCalls).toHaveLength(0)
    const spawn = agentSpawnParts()[0]
    expect(spawn.output?.value?.result).toContain('oracle reply')
  })
})

describe('agent reload reconciliation', () => {
  it('turns a persisted running delegation into interrupted on load', () => {
    const parent: ChatThread = {
      id: 'th1',
      title: 'Thread',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-spawn_agent',
              toolCallId: 'c1',
              state: 'output-available',
              input: {},
              output: { ok: true, code: 'ok', value: { status: 'running', runId: 'r1' } },
            } as unknown as UIMessage['parts'][number],
          ],
        },
      ],
      config: defaultThreadConfig('parent', 'm1'),
      createdAt: 1,
      updatedAt: 1,
    }
    const part = rehydrateThread(parent).messages[0].parts[0] as unknown as {
      output: { value: { status: string } }
    }
    expect(part.output.value.status).toBe('interrupted')
  })
})
