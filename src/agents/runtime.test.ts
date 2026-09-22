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
import { AgentRunStore } from './store'
import type { AgentRunRecord } from './store'
import type { AgentParentContext } from './types'

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'finish'; usage: Usage; finishReason: { unified: 'stop'; raw: undefined } }

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

function build(model: MockLanguageModelV4) {
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
  })
  return { store, runtime, onSettle }
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
})
