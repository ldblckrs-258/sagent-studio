import type { LanguageModel } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { createApprovalQueue } from './approval-queue'
import { runAgent } from './runner'
import type { AgentRunInput } from './runner'
import type {
  AgentParentContext,
  AgentRunEvent,
  AgentSteeringControl,
  AgentStopReason,
} from './types'

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

function steeringControl(): {
  control: AgentSteeringControl
  enqueue(text: string): void
  requestStop(reason: AgentStopReason): void
} {
  const pending: string[] = []
  let reason: AgentStopReason | undefined
  const control: AgentSteeringControl = {
    drain: () => pending.splice(0, pending.length),
    enqueue: (text) => {
      pending.push(text)
    },
    stopRequested: () => reason !== undefined,
    stopReason: () => reason,
    requestStop: (next) => {
      reason = next
    },
  }
  return {
    control,
    enqueue: (text) => control.enqueue(text),
    requestStop: (next) => control.requestStop(next),
  }
}

function buildDeps(
  model: MockLanguageModelV4,
  executed: string[],
  overrides: {
    settings?: ReturnType<typeof defaultSettings>
    queue?: ReturnType<typeof createApprovalQueue>
    steering?: AgentSteeringControl
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
    ...(overrides.steering !== undefined ? { steering: overrides.steering } : {}),
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
    expect(result.stopReason).toBeUndefined()
    expect(queue.pending()).toHaveLength(0)
    expect(executed).toEqual([])
  })

  it('returns stopped with the user_stop reason when a stop was requested', async () => {
    const model = new MockLanguageModelV4({
      doStream: [{ stream: streamOf(toolStep('c1', 'create_skill', {})) }],
    })
    const executed: string[] = []
    const steering = steeringControl()
    const { controller, deps, queue } = buildDeps(model, executed, { steering: steering.control })

    const run = runAgent(input(), deps, controller.signal, () => {})
    await waitFor(() => queue.pending().length > 0)
    steering.requestStop('user_stop')
    controller.abort()
    const result = await run

    expect(result.status).toBe('stopped')
    expect(result.stopReason).toBe('user_stop')
  })

  it('delivers a steering message in a continuation pass and records it', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'read_file')) },
        { stream: streamOf(textStep('t2', 'first answer')) },
        { stream: streamOf(textStep('t3', 'steered answer')) },
      ],
    })
    const executed: string[] = []
    const steering = steeringControl()
    const { controller, deps } = buildDeps(model, executed, { steering: steering.control })
    const events: AgentRunEvent[] = []
    let enqueued = false

    const result = await runAgent(input(), deps, controller.signal, (event) => {
      events.push(event)
      if (!enqueued && event.type === 'text-delta') {
        enqueued = true
        steering.enqueue('please steer')
      }
    })

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('please steer')
    expect(
      events.some((event) => event.type === 'user-message' && event.text === 'please steer'),
    ).toBe(true)
    expect(result.text).toContain('steered answer')
  })

  it('keeps draining steering turns with no fixed budget', async () => {
    const model = new MockLanguageModelV4({
      doStream: Array.from({ length: 35 }, (_, index) => ({
        stream: streamOf(textStep(`t${index}`, 'ok')),
      })),
    })
    const executed: string[] = []
    let drained = 0
    const steering: AgentSteeringControl = {
      drain: () => (drained < 30 ? ((drained += 1), ['keep going']) : []),
      enqueue: () => {},
      stopRequested: () => false,
      stopReason: () => undefined,
      requestStop: () => {},
    }
    const { controller, deps } = buildDeps(model, executed, { steering })
    let userMessages = 0

    await runAgent(input(), deps, controller.signal, (event) => {
      if (event.type === 'user-message') userMessages += 1
    })

    expect(userMessages).toBe(30)
    expect(model.doStreamCalls).toHaveLength(31)
  })

  it('keeps a prepareStep-injected steer in a later pass\u2019s history', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'read_file')) },
        { stream: streamOf(textStep('t2', 'first answer')) },
        { stream: streamOf(textStep('t3', 'second answer')) },
      ],
    })
    const executed: string[] = []
    const pending: string[] = []
    const steering: AgentSteeringControl = {
      drain: () => pending.splice(0, pending.length),
      enqueue: (text) => {
        pending.push(text)
      },
      stopRequested: () => false,
      stopReason: () => undefined,
      requestStop: () => {},
    }
    const { controller, deps } = buildDeps(model, executed, { steering })
    let enqueuedSecond = false

    const result = await runAgent(input(), deps, controller.signal, (event) => {
      // The tool result lets the next step's prepareStep inject; the second
      // steer is queued too late for that step, so it triggers the next pass.
      if (event.type === 'tool-call') steering.enqueue('first steer')
      if (!enqueuedSecond && event.type === 'text-delta' && event.text === 'first answer') {
        enqueuedSecond = true
        steering.enqueue('second steer')
      }
    })

    expect(result.status).toBe('completed')
    expect(model.doStreamCalls).toHaveLength(3)
    // Pass 1 injected 'first steer' through its `prepareStep` override; pass 2
    // (the third model call) must still carry it in its own prompt.
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('first steer')
  })

  it('closes the steering channel once the run settles', async () => {
    const model = new MockLanguageModelV4({
      doStream: [{ stream: streamOf(textStep('t1', 'done')) }],
    })
    const executed: string[] = []
    const close = vi.fn()
    const steering: AgentSteeringControl = {
      drain: () => [],
      enqueue: () => {},
      stopRequested: () => false,
      stopReason: () => undefined,
      requestStop: () => {},
      accepting: () => true,
      close,
    }
    const { controller, deps } = buildDeps(model, executed, { steering })

    const result = await runAgent(input(), deps, controller.signal, () => {})

    expect(result.status).toBe('completed')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('runs every tool step the model asks for, with no step cap', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        ...Array.from({ length: 30 }, (_, index) => ({
          stream: streamOf(toolStep(`c${index}`, 'read_file')),
        })),
        { stream: streamOf(textStep('final', 'finished')) },
      ],
    })
    const executed: string[] = []
    const { controller, deps } = buildDeps(model, executed)

    const result = await runAgent(input(), deps, controller.signal, () => {})

    expect(result.toolCalls).toBe(30)
    expect(result.status).toBe('completed')
  })

  it('reports invalid_input for an unknown requested skill', async () => {
    const model = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('t1', 'x')) }] })
    const executed: string[] = []
    const { controller, deps } = buildDeps(model, executed)

    const result = await runAgent(input({ skills: ['missing'] }), deps, controller.signal, () => {})

    expect(result.status).toBe('invalid_input')
  })
})
