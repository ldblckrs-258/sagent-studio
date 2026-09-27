import type { LanguageModel } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { createAgentRuntime } from './runtime'
import type { AgentRunPersistence, AgentRunSnapshot } from './runtime'
import { AgentRunStore } from './store'
import type { AgentRunRecord } from './store'
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

function textStep(id: string, delta: string): ReadableStream<Chunk> {
  const chunks: Chunk[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ]
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function toolStep(id: string, toolName: string): ReadableStream<Chunk> {
  const input = '{}'
  const chunks: Chunk[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: input },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
  ]
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/**
 * A stream that never emits and closes only when its run is aborted, so the run
 * stays active until the controller fires.
 */
function pendingStream(abortSignal?: AbortSignal): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      const onAbort = () =>
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (abortSignal?.aborted) onAbort()
      else abortSignal?.addEventListener('abort', onAbort, { once: true })
    },
  })
}

function pendingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({ stream: pendingStream(abortSignal) }),
  })
}

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }

function recorderProvider(): ToolProvider {
  return {
    names: ['read_file'],
    isAvailable: () => true,
    create: (name) =>
      tool({
        description: name,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => `${name}:ok`,
      }),
  }
}

function context(parentThreadId = 'parent-1'): AgentParentContext {
  return {
    parentThreadId,
    mode: 'editing',
    toolNames: ['read_file'],
    providerId: 'p1',
    modelId: 'm1',
    systemInstruction: '',
  }
}

function build(model: MockLanguageModelV4, persistence?: AgentRunPersistence) {
  const store = new AgentRunStore()
  const toolRegistry = new ToolRegistry()
  toolRegistry.registerProvider(recorderProvider())
  const onSettle = vi.fn()
  const runtime = createAgentRuntime({
    getSettings: () => defaultSettings(),
    skillRegistry: new SkillRegistry(skillStore),
    toolRegistry,
    store,
    modelFactory: () => model as unknown as LanguageModel,
    portsFor: () => ({}) as ToolRuntimePorts,
    onSettle,
    ...(persistence ? { persistence } : {}),
  })
  return { store, runtime, onSettle }
}

function snapshot(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    runId: 'run-x',
    parentThreadId: 'parent-1',
    providerId: 'p1',
    mode: 'editing',
    tier: 'cheap',
    status: 'completed',
    prompt: 'settled task',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'settled task' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'settled answer' }] },
    ],
    startedAt: 1,
    ...overrides,
  }
}

/** A persistence double over an in-memory child-run list. */
function persistenceOver(runs: AgentRunSnapshot[] = []): AgentRunPersistence {
  const stored = [...runs]
  const upsert = (next: AgentRunSnapshot): void => {
    const index = stored.findIndex((run) => run.runId === next.runId)
    if (index >= 0) stored[index] = next
    else stored.push(next)
  }
  return {
    create: async (next) => upsert(next),
    save: async (next) => upsert(next),
    load: async (runId) => stored.find((run) => run.runId === runId) ?? null,
    list: async (parentThreadId) =>
      stored.filter((run) => run.parentThreadId === parentThreadId).reverse(),
  }
}

function settledRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: 'run-live',
    parentThreadId: 'parent-1',
    mode: 'editing',
    tier: 'cheap',
    status: 'completed',
    prompt: 'do the task',
    text: 'hello',
    toolCalls: 1,
    approvals: [],
    startedAt: 1,
    events: [
      { type: 'text-delta', text: 'thinking' },
      { type: 'tool-call', toolName: 'read_file', toolCallId: 'c1', input: {} },
      { type: 'text-delta', text: 'hello' },
    ],
    ...overrides,
  }
}

async function waitForStatus(
  store: AgentRunStore,
  runId: string,
  timeoutMs = 2000,
): Promise<AgentRunRecord> {
  const started = Date.now()
  for (;;) {
    const run = store.get(runId)
    if (run && run.status !== 'running') return run
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for settle.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('createAgentRuntime', () => {
  it('returns an awaited result and does not call onSettle', async () => {
    const model = new MockLanguageModelV4({ doStream: [{ stream: textStep('t1', 'done') }] })
    const { runtime, onSettle, store } = build(model)

    const outcome = await runtime.spawn(context(), {
      prompt: 'go',
      mode: 'read_only',
      tier: 'cheap',
    })

    expect(outcome.status).toBe('completed')
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].status).toBe('completed')
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('settles a background run and calls onSettle once', async () => {
    const model = new MockLanguageModelV4({ doStream: [{ stream: textStep('t1', 'bg done') }] })
    const { runtime, onSettle, store } = build(model)

    const outcome = await runtime.spawn(context(), { prompt: 'go', mode: 'editing', tier: 'medium', background: true })
    expect(outcome.status).toBe('running')
    if (outcome.status !== 'running') return

    const settled = await waitForStatus(store, outcome.runId)
    expect(settled.status).toBe('completed')
    expect(settled.text).toContain('bg done')
    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1))
  })

  it('enforces the per-thread cap, counting running agents', async () => {
    const { runtime } = build(pendingModel())
    const parent = context('thread-a')

    const first = await runtime.spawn(parent, { prompt: '1', mode: 'editing', tier: 'medium', background: true })
    const second = await runtime.spawn(parent, { prompt: '2', mode: 'editing', tier: 'medium', background: true })
    const third = await runtime.spawn(parent, { prompt: '3', mode: 'editing', tier: 'medium', background: true })
    const fourth = await runtime.spawn(parent, { prompt: '4', mode: 'editing', tier: 'medium', background: true })

    expect([first.status, second.status, third.status]).toEqual(['running', 'running', 'running'])
    expect(fourth.status).toBe('limit_exceeded')
    expect(runtime.activeForThread('thread-a')).toBe(3)
    runtime.dispose()
  })

  it('aborts a thread\'s runs and settles them', async () => {
    const { runtime, store } = build(pendingModel())

    const outcome = await runtime.spawn(context('thread-a'), {
      prompt: 'go',
      mode: 'editing',
      tier: 'medium',
      background: true,
    })
    if (outcome.status !== 'running') throw new Error('expected a running outcome')

    runtime.abortThread('thread-a')
    const settled = await waitForStatus(store, outcome.runId)
    expect(settled.status).toBe('aborted')
    expect(runtime.activeForThread('thread-a')).toBe(0)
    runtime.dispose()
  })

  it('rejects control from another parent thread', async () => {
    const { runtime } = build(pendingModel())
    const outcome = await runtime.spawn(context('thread-a'), {
      prompt: 'go',
      mode: 'editing',
      tier: 'medium',
      background: true,
    })
    if (outcome.status !== 'running') throw new Error('expected a running outcome')

    expect(runtime.steer('thread-b', outcome.runId, 'hi')).toBe(false)
    expect(runtime.stop('thread-b', outcome.runId)).toBe(false)
    await expect(runtime.read('thread-b', outcome.runId)).resolves.toBeNull()
    await expect(
      runtime.resolveRun('thread-b', { runId: outcome.runId }),
    ).resolves.toBeNull()

    expect(runtime.steer('thread-a', outcome.runId, 'hi')).toBe(true)
    runtime.dispose()
  })

  it('stops a live run and records the user stop', async () => {
    const { runtime, store, onSettle } = build(pendingModel())
    const outcome = await runtime.spawn(context('thread-a'), {
      prompt: 'go',
      mode: 'editing',
      tier: 'medium',
      background: true,
    })
    if (outcome.status !== 'running') throw new Error('expected a running outcome')

    expect(runtime.stop('thread-a', outcome.runId)).toBe(true)
    const settled = await waitForStatus(store, outcome.runId)
    expect(settled.status).toBe('stopped')
    expect(settled.stopReason).toBe('user_stop')
    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1))
    runtime.dispose()
  })

  it('reads a live run\u2019s turns and honours lastN and includeTools', async () => {
    const { runtime, store } = build(pendingModel())
    store.register(settledRecord())

    const textOnly = await runtime.read('parent-1', 'run-live')
    expect(textOnly?.turns).toEqual([
      { role: 'user', text: 'do the task' },
      { role: 'assistant', text: 'thinking' },
      { role: 'assistant', text: 'hello' },
    ])

    const withTools = await runtime.read('parent-1', 'run-live', { includeTools: true })
    expect(withTools?.turns).toEqual([
      { role: 'user', text: 'do the task' },
      { role: 'assistant', text: 'thinking' },
      { role: 'tool', text: '', toolName: 'read_file' },
      { role: 'assistant', text: 'hello' },
    ])

    const lastTwo = await runtime.read('parent-1', 'run-live', { lastN: 2 })
    expect(lastTwo?.turns).toEqual([
      { role: 'assistant', text: 'thinking' },
      { role: 'assistant', text: 'hello' },
    ])
  })

  it('clamps lastN between 1 and 50', async () => {
    const { runtime, store } = build(pendingModel())
    store.register(
      settledRecord({
        events: Array.from({ length: 60 }, (_, index) => ({
          type: 'user-message' as const,
          text: `steer ${index}`,
        })),
      }),
    )

    const capped = await runtime.read('parent-1', 'run-live', { lastN: 999 })
    expect(capped?.turns).toHaveLength(50)
    const floor = await runtime.read('parent-1', 'run-live', { lastN: 0 })
    expect(floor?.turns).toHaveLength(1)
  })

  it('reads a settled run from persistence without crossing parents', async () => {
    const persistence = persistenceOver([snapshot()])
    const { runtime } = build(pendingModel(), persistence)

    const transcript = await runtime.read('parent-1', 'run-x')
    expect(transcript).toMatchObject({ runId: 'run-x', status: 'completed' })
    expect(transcript?.turns).toEqual([
      { role: 'user', text: 'settled task' },
      { role: 'assistant', text: 'settled answer' },
    ])

    await expect(runtime.read('parent-2', 'run-x')).resolves.toBeNull()
  })

  it('projects a reloaded run\u2019s tool call as a tool turn, hidden without includeTools', async () => {
    const model = new MockLanguageModelV4({
      doStream: [{ stream: toolStep('c1', 'read_file') }, { stream: textStep('t2', 'finished') }],
    })
    const persistence = persistenceOver()
    const { runtime, store } = build(model, persistence)

    const outcome = await runtime.spawn(context(), {
      prompt: 'do the task',
      mode: 'editing',
      tier: 'cheap',
      background: true,
    })
    if (outcome.status !== 'running') throw new Error('expected a running outcome')
    await waitForStatus(store, outcome.runId)
    // Force the persisted path so the test exercises the stored transcript, not
    // the live record.
    store.remove(outcome.runId)

    const withTools = await runtime.read('parent-1', outcome.runId, { includeTools: true })
    expect(withTools?.turns).toEqual([
      { role: 'user', text: 'do the task' },
      { role: 'tool', text: '', toolName: 'read_file' },
      { role: 'assistant', text: 'finished' },
    ])

    const withoutTools = await runtime.read('parent-1', outcome.runId)
    expect(withoutTools?.turns).toEqual([
      { role: 'user', text: 'do the task' },
      { role: 'assistant', text: 'finished' },
    ])
    expect(JSON.stringify(withoutTools?.turns)).not.toContain('[called')
  })

  it('resolves a unique label and rejects ambiguity', async () => {
    const persistence = persistenceOver([
      snapshot({ runId: 'run-p', label: 'scout' }),
      snapshot({ runId: 'run-q', parentThreadId: 'parent-2', label: 'scout' }),
    ])
    const { runtime, store } = build(pendingModel(), persistence)
    store.register(settledRecord({ runId: 'run-a', label: 'twin', status: 'running' }))
    store.register(settledRecord({ runId: 'run-b', label: 'twin', status: 'running' }))

    await expect(runtime.resolveRun('parent-1', { label: 'twin' })).resolves.toBeNull()
    await expect(runtime.resolveRun('parent-1', { label: 'scout' })).resolves.toEqual({
      runId: 'run-p',
      label: 'scout',
      status: 'completed',
    })

    store.remove('run-b')
    await expect(runtime.resolveRun('parent-1', { label: 'twin' })).resolves.toEqual({
      runId: 'run-a',
      label: 'twin',
      status: 'running',
    })
    await expect(runtime.resolveRun('parent-1', { runId: 'run-q' })).resolves.toBeNull()
    await expect(runtime.resolveRun('parent-1', { label: 'absent' })).resolves.toBeNull()
  })
})
