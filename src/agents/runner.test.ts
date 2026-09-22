import type { LanguageModel } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { createApprovalQueue } from './approval-queue'
import { runAgent } from './runner'
import type { AgentRunInput } from './runner'
import type { AgentParentContext } from './types'

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

function toolStep(id: string, toolName: string, input: unknown = {}): Chunk[] {
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

// `create_skill` is gated and inside the editing ceiling but is not
// mode-granted, so it is the tool that asks for approval in these tests.
const TOOL_NAMES = ['read_file', 'write_file', 'create_skill']

function recorderProvider(executed: string[]): ToolProvider {
  return {
    names: TOOL_NAMES,
    isAvailable: () => true,
    create: (name) =>
      tool({
        description: name,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => {
          executed.push(name)
          return `${name}:ok`
        },
      }),
  }
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

function buildDeps(
  model: MockLanguageModelV4,
  executed: string[],
  overrides: {
    settings?: ReturnType<typeof defaultSettings>
    maxSteps?: number
    queue?: ReturnType<typeof createApprovalQueue>
  } = {},
) {
  const controller = new AbortController()
  const toolRegistry = new ToolRegistry()
  toolRegistry.registerProvider(recorderProvider(executed))
  const queue = overrides.queue ?? createApprovalQueue({ signal: controller.signal })
  const deps = {
    settings: overrides.settings ?? defaultSettings(),
    skillRegistry: new SkillRegistry(skillStore),
    toolRegistry,
    ports: {} as ToolRuntimePorts,
    modelFactory: () => model as unknown as LanguageModel,
    queue,
    ...(overrides.maxSteps !== undefined ? { maxSteps: overrides.maxSteps } : {}),
  }
  return { controller, deps, queue }
}

function input(request: Partial<AgentRunInput['request']> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    request: { prompt: 'do the thing', mode: 'editing', tier: 'medium', ...request },
    parent: parent(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('runAgent', () => {
  it('runs a tool and returns the model text', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'read_file', { path: 'a.txt' })) },
        { stream: streamOf(textStep('t2', 'all done')) },
      ],
    })
    const executed: string[] = []
    const { controller, deps } = buildDeps(model, executed)

    const result = await runAgent(input(), deps, controller.signal, () => {})

    expect(result.status).toBe('completed')
    expect(result.toolCalls).toBe(1)
    expect(executed).toEqual(['read_file'])
    expect(result.text).toContain('all done')
  })

  it('short-circuits a denied tool without executing it', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'create_skill', {})) },
        { stream: streamOf(textStep('t2', 'skipped it')) },
      ],
    })
    const executed: string[] = []
    const settings = defaultSettings()
    settings.approvals = { tools: { create_skill: 'deny' } }
    const { controller, deps } = buildDeps(model, executed, { settings })

    const result = await runAgent(input(), deps, controller.signal, () => {})

    expect(executed).toEqual([])
    expect(result.status).toBe('completed')
    expect(result.text).toContain('skipped it')
  })

  it('settles a pending approval when the run aborts', async () => {
    const model = new MockLanguageModelV4({
      doStream: [{ stream: streamOf(toolStep('c1', 'create_skill', {})) }],
    })
    const executed: string[] = []
    const { controller, deps, queue } = buildDeps(model, executed)

    const run = runAgent(input(), deps, controller.signal, () => {})
    await waitFor(() => queue.pending().length > 0)
    controller.abort()
    const result = await run

    expect(result.status).toBe('aborted')
    expect(queue.pending()).toHaveLength(0)
    expect(executed).toEqual([])
  })

  it('stops after the step cap', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'read_file')) },
        { stream: streamOf(toolStep('c2', 'read_file')) },
        { stream: streamOf(toolStep('c3', 'read_file')) },
      ],
    })
    const executed: string[] = []
    const { controller, deps } = buildDeps(model, executed, { maxSteps: 2 })

    const result = await runAgent(input(), deps, controller.signal, () => {})

    expect(result.toolCalls).toBe(2)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('reports invalid_input for an unknown requested skill', async () => {
    const model = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('t1', 'x')) }] })
    const executed: string[] = []
    const { controller, deps } = buildDeps(model, executed)

    const result = await runAgent(input({ skills: ['missing'] }), deps, controller.signal, () => {})

    expect(result.status).toBe('invalid_input')
  })
})
