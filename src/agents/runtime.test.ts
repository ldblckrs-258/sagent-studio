import type { LanguageModel, UIMessage } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { createWorkspaceJournal } from '../workspace/journal'
import { tagJournal } from '../workspace/run-journal'
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
    messages: [
      { id: 'p', role: 'user', parts: [{ type: 'text', text: 'do the task' }] },
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'thinking' },
          {
            type: 'tool-read_file',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: 'ok',
          },
          { type: 'text', text: 'hello' },
        ] as UIMessage['parts'],
      },
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

  it('keeps the settled status when an earlier mid-run save finishes last', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await new Promise((resolve) => setTimeout(resolve, 450))
        return { stream: textStep('t1', 'done') }
      },
    })
    const written: string[] = []
    let saves = 0
    const persistence: AgentRunPersistence = {
      create: async () => {},
      save: async (next) => {
        saves += 1
        if (saves === 1) await new Promise((resolve) => setTimeout(resolve, 60))
        written.push(next.status)
      },
      load: async () => null,
      list: async () => [],
    }
    const { runtime } = build(model, persistence)

    await runtime.spawn(context(), { prompt: 'go', mode: 'read_only', tier: 'cheap' })

    expect(written.length).toBeGreaterThan(1)
    expect(written.at(-1)).toBe('completed')
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
        messages: Array.from({ length: 60 }, (_, index) => ({
          id: `s${index}`,
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: `steer ${index}` }],
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

  describe('continue', () => {
    function textOfMessage(message: UIMessage): string {
      return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    }

    function buildWith(model: MockLanguageModelV4, persistence?: AgentRunPersistence, store = new AgentRunStore()) {
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
      return { runtime, store, onSettle }
    }

    it('continues a finished run with its own history and extends the transcript in place', async () => {
      const model = new MockLanguageModelV4({
        doStream: [
          { stream: toolStep('c1', 'read_file') },
          { stream: textStep('t2', 'first answer') },
          { stream: textStep('t3', 'second answer') },
        ],
      })
      const { runtime, store } = buildWith(model)
      const first = await runtime.spawn(context(), { prompt: 'look', mode: 'editing', tier: 'medium' })
      if (first.status !== 'completed') throw new Error('expected an awaited run')
      const before = store.get(first.runId)?.messages ?? []
      const statuses: string[] = []
      const unsubscribe = store.subscribe(() => {
        const status = store.get(first.runId)?.status
        if (status && statuses[statuses.length - 1] !== status) statuses.push(status)
      })

      const next = await runtime.continue(context(), first.runId, 'now check the tests')
      unsubscribe()

      expect(next.status).toBe('completed')
      if (next.status === 'completed') expect(next.result.text).toBe('second answer')
      expect(statuses).toEqual(['running', 'completed'])
      const prompt = JSON.stringify(model.doStreamCalls[2].prompt)
      expect(prompt).toContain('first answer')
      expect(prompt).toContain('read_file:ok')
      expect(prompt).toContain('now check the tests')
      const after = store.get(first.runId)?.messages ?? []
      expect(after.slice(0, before.length)).toEqual(before)
      expect(after.slice(before.length).map((message) => [message.role, textOfMessage(message)])).toEqual([
        ['user', 'now check the tests'],
        ['assistant', 'second answer'],
      ])
      expect(new Set(after.map((message) => message.id)).size).toBe(after.length)
    })

    it('continues a run that only exists in persistence, as after a reload', async () => {
      const persistence = persistenceOver()
      const model = new MockLanguageModelV4({
        doStream: [{ stream: textStep('t1', 'first answer') }, { stream: textStep('t2', 'resumed') }],
      })
      const first = await buildWith(model, persistence).runtime.spawn(context(), {
        prompt: 'look',
        mode: 'read_only',
        tier: 'cheap',
      })
      if (first.status !== 'completed') throw new Error('expected an awaited run')

      const reloaded = buildWith(model, persistence, new AgentRunStore())
      const next = await reloaded.runtime.continue(context(), first.runId, 'keep going')

      expect(next.status).toBe('completed')
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('first answer')
      const saved = await persistence.load(first.runId)
      expect(saved?.messages.map((message) => textOfMessage(message))).toEqual([
        'look',
        'first answer',
        'keep going',
        'resumed',
      ])
    })

    it('applies the per-conversation limit to continues', async () => {
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({ stream: pendingStream(abortSignal) }),
      })
      const { runtime, store } = buildWith(model)
      store.register(settledRecord({ runId: 'done', spec: { mode: 'editing', toolNames: ['read_file'] } }))
      for (const prompt of ['1', '2', '3']) {
        await runtime.spawn(context(), { prompt, mode: 'editing', tier: 'medium', background: true })
      }

      const outcome = await runtime.continue(context(), 'done', 'more')

      expect(outcome.status).toBe('limit_exceeded')
      runtime.dispose()
    })

    it('holds the limits and a single live stream when continues race each other', async () => {
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({ stream: pendingStream(abortSignal) }),
      })
      const persistence = persistenceOver(
        ['r1', 'r2', 'r3', 'r4'].map((runId) =>
          snapshot({ runId, spec: { mode: 'editing', toolNames: ['read_file'] } }),
        ),
      )
      const { runtime } = buildWith(model, persistence)

      const outcomes = await Promise.all(
        ['r1', 'r2', 'r3', 'r4'].map((runId) => runtime.continue(context(), runId, 'more', { background: true })),
      )
      const duplicate = await Promise.all([
        runtime.continue(context('parent-2'), 'r1', 'again', { background: true }),
        runtime.continue(context(), 'r1', 'again', { background: true }),
      ])

      expect(outcomes.filter((outcome) => outcome.status === 'running')).toHaveLength(3)
      expect(outcomes.filter((outcome) => outcome.status === 'limit_exceeded')).toHaveLength(1)
      expect(runtime.activeForThread('parent-1')).toBe(3)
      expect(duplicate.map((outcome) => outcome.status)).not.toContain('running')
      expect(runtime.activeCount()).toBe(3)
      runtime.dispose()
    })

    it('never starts two streams for one run when the same continue is sent twice at once', async () => {
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({ stream: pendingStream(abortSignal) }),
      })
      const persistence = persistenceOver([snapshot({ runId: 'r1', spec: { mode: 'editing', toolNames: ['read_file'] } })])
      const { runtime } = buildWith(model, persistence)

      const [first, second] = await Promise.all([
        runtime.continue(context(), 'r1', 'one', { background: true }),
        runtime.continue(context(), 'r1', 'two', { background: true }),
      ])

      expect([first.status, second.status].sort()).toEqual(['invalid_input', 'running'])
      expect(runtime.activeCount()).toBe(1)
      expect(runtime.stop('parent-1', 'r1')).toBe(true)
      runtime.dispose()
    })

    it('clamps a continued run to the parent mode as it is now', async () => {
      const model = new MockLanguageModelV4({
        doStream: [{ stream: textStep('t1', 'edited') }, { stream: textStep('t2', 'read only now') }],
      })
      const { runtime } = buildWith(model)
      const first = await runtime.spawn(context(), { prompt: 'edit', mode: 'editing', tier: 'medium' })
      if (first.status !== 'completed') throw new Error('expected an awaited run')
      expect(first.result.mode).toBe('editing')

      const next = await runtime.continue({ ...context(), mode: 'read_only' }, first.runId, 'again')

      expect(next.status).toBe('completed')
      if (next.status === 'completed') expect(next.result.mode).toBe('read_only')
    })

    it('refuses a running run, a foreign run, and a legacy run without a spec', async () => {
      const { runtime, store } = buildWith(pendingModel(), persistenceOver([snapshot({ runId: 'legacy' })]))
      const live = await runtime.spawn(context(), { prompt: 'x', mode: 'editing', tier: 'medium', background: true })
      if (live.status !== 'running') throw new Error('expected a background run')
      store.register(settledRecord({ runId: 'foreign', parentThreadId: 'parent-2', spec: { mode: 'editing', toolNames: [] } }))

      const running = await runtime.continue(context(), live.runId, 'more')
      const foreign = await runtime.continue(context(), 'foreign', 'more')
      const legacy = await runtime.continue(context(), 'legacy', 'more')

      expect(running).toMatchObject({ status: 'invalid_input', message: expect.stringContaining('steer') })
      expect(foreign.status).toBe('invalid_input')
      expect(legacy).toMatchObject({
        status: 'invalid_input',
        message: expect.stringContaining('before runs could be continued'),
      })
      runtime.dispose()
    })

    it('settles a background continue through onSettle like a spawn', async () => {
      const model = new MockLanguageModelV4({
        doStream: [{ stream: textStep('t1', 'one') }, { stream: textStep('t2', 'two') }],
      })
      const { runtime, store, onSettle } = buildWith(model)
      const first = await runtime.spawn(context(), { prompt: 'x', mode: 'editing', tier: 'medium' })
      if (first.status !== 'completed') throw new Error('expected an awaited run')

      const next = await runtime.continue(context(), first.runId, 'more', { background: true })
      expect(next.status).toBe('running')
      await waitForStatus(store, first.runId)

      expect(onSettle).toHaveBeenCalledTimes(1)
      expect(onSettle.mock.calls[0][1].text).toBe('two')
    })
  })

  describe('wait', () => {
    function gatedModel() {
      const gates = new Map<string, () => void>()
      const opened = new Set<string>()
      const release = (prompt: string): void => {
        opened.add(prompt)
        gates.get(prompt)?.()
      }
      const model = new MockLanguageModelV4({
        doStream: async ({ prompt, abortSignal }) => {
          const task = JSON.stringify(prompt).match(/task-[a-z]/)?.[0] ?? 'task-?'
          const stream = new ReadableStream<Chunk>({
            start(controller) {
              const finish = () => {
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({ type: 'text-start', id: 't' })
                controller.enqueue({ type: 'text-delta', id: 't', delta: `${task} done` })
                controller.enqueue({ type: 'text-end', id: 't' })
                controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } })
                controller.close()
              }
              abortSignal?.addEventListener(
                'abort',
                () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              )
              if (opened.has(task)) finish()
              else gates.set(task, finish)
            },
          })
          return { stream }
        },
      })
      return { model, release }
    }

    async function spawnBackground(runtime: ReturnType<typeof build>['runtime'], task: string, parent = context()) {
      const outcome = await runtime.spawn(parent, {
        prompt: task,
        mode: 'read_only',
        tier: 'cheap',
        background: true,
        label: task,
      })
      if (outcome.status !== 'running') throw new Error('expected a background run')
      return outcome.runId
    }

    it('gathers every run with mode all and appends no notice for them', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const b = await spawnBackground(runtime, 'task-b')

      const waiting = runtime.wait('parent-1', { runIds: [a, b], mode: 'all' })
      release('task-a')
      await new Promise((resolve) => setTimeout(resolve, 20))
      let settled = false
      void waiting.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(settled).toBe(false)
      release('task-b')
      const outcome = await waiting

      expect(outcome).toMatchObject({ ok: true, timedOut: false })
      if (outcome.ok) {
        expect(outcome.runs.map((run) => [run.label, run.status, run.result])).toEqual([
          ['task-a', 'completed', 'task-a done'],
          ['task-b', 'completed', 'task-b done'],
        ])
      }
      expect(onSettle).not.toHaveBeenCalled()
    })

    it('returns at the first run with mode any and lets the rest report back later', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle, store } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const b = await spawnBackground(runtime, 'task-b')

      const waiting = runtime.wait('parent-1', { labels: ['task-a', 'task-b'], mode: 'any' })
      release('task-b')
      const outcome = await waiting

      if (!outcome.ok) throw new Error(outcome.message)
      expect(outcome.runs.find((run) => run.runId === b)?.status).toBe('completed')
      expect(outcome.runs.find((run) => run.runId === a)?.status).toBe('running')
      expect(onSettle).not.toHaveBeenCalled()

      release('task-a')
      await waitForStatus(store, a)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle).toHaveBeenCalledTimes(1)
      expect(onSettle.mock.calls[0][0].runId).toBe(a)
    })

    it('returns settled results at the timeout and keeps the notice for the pending run', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle, store } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const b = await spawnBackground(runtime, 'task-b')
      release('task-a')
      await waitForStatus(store, a)
      onSettle.mockClear()

      const outcome = await runtime.wait('parent-1', { runIds: [a, b], timeoutMs: 30 })

      if (!outcome.ok) throw new Error(outcome.message)
      expect(outcome.timedOut).toBe(true)
      expect(outcome.runs.map((run) => run.status)).toEqual(['completed', 'running'])
      release('task-b')
      await waitForStatus(store, b)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle).toHaveBeenCalledTimes(1)
      expect(onSettle.mock.calls[0][0].runId).toBe(b)
    })

    it('stops waiting when the parent turn aborts but leaves the runs going', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle, store } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const controller = new AbortController()

      const waiting = runtime.wait('parent-1', {}, controller.signal)
      controller.abort()
      const outcome = await waiting

      expect(outcome).toMatchObject({ ok: true, aborted: true })
      expect(store.get(a)?.status).toBe('running')
      release('task-a')
      await waitForStatus(store, a)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle).toHaveBeenCalledTimes(1)
    })

    it('still reports a run that finished during a wait the parent then abandoned', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle, store } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const b = await spawnBackground(runtime, 'task-b')
      const controller = new AbortController()

      const waiting = runtime.wait('parent-1', { runIds: [a, b] }, controller.signal)
      release('task-a')
      await waitForStatus(store, a)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle).not.toHaveBeenCalled()
      controller.abort()
      await waiting

      expect(onSettle.mock.calls.map((call) => call[0].runId)).toEqual([a])
      release('task-b')
      await waitForStatus(store, b)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle.mock.calls.map((call) => call[0].runId)).toEqual([a, b])
    })

    it('returns at once in any mode when a target has already finished', async () => {
      const { model, release } = gatedModel()
      const { runtime, onSettle, store } = build(model)
      const a = await spawnBackground(runtime, 'task-a')
      const b = await spawnBackground(runtime, 'task-b')
      release('task-a')
      await waitForStatus(store, a)
      onSettle.mockClear()

      const outcome = await runtime.wait('parent-1', { runIds: [a, b], mode: 'any', timeoutMs: 60_000 })

      if (!outcome.ok) throw new Error(outcome.message)
      expect(outcome.runs.map((run) => [run.runId, run.status])).toEqual([
        [a, 'completed'],
        [b, 'running'],
      ])
      expect(outcome.timedOut).toBe(false)
      release('task-b')
      await waitForStatus(store, b)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onSettle).toHaveBeenCalledTimes(1)
      runtime.dispose()
    })

    it('reports a run that finishes while an abandoned wait is still reading a stored run', async () => {
      const { model, release } = gatedModel()
      let loads = 0
      let openLoad!: () => void
      const loadGate = new Promise<void>((resolve) => {
        openLoad = resolve
      })
      const stored = persistenceOver([snapshot({ runId: 'old', label: 'old' })])
      const persistence: AgentRunPersistence = {
        ...stored,
        load: async (runId) => {
          loads += 1
          if (runId === 'old' && loads > 1) await loadGate
          return stored.load(runId)
        },
      }
      const { runtime, onSettle, store } = build(model, persistence)
      const x = await spawnBackground(runtime, 'task-x')
      const controller = new AbortController()

      const waiting = runtime.wait('parent-1', { runIds: ['old', x] }, controller.signal)
      await new Promise((resolve) => setTimeout(resolve, 5))
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 5))
      release('task-x')
      await waitForStatus(store, x)
      await new Promise((resolve) => setTimeout(resolve, 10))
      openLoad()
      await waiting
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(onSettle.mock.calls.map((call) => call[0].runId)).toEqual([x])
    })

    it('returns an empty gather at once when nothing is running', async () => {
      const { model } = gatedModel()
      const { runtime } = build(model)

      const outcome = await runtime.wait('parent-1', { runIds: [], labels: [] })

      expect(outcome).toEqual({ ok: true, runs: [], timedOut: false, aborted: false })
    })

    it('refuses to wait on another conversation\'s run', async () => {
      const { model } = gatedModel()
      const { runtime } = build(model)
      const foreign = await spawnBackground(runtime, 'task-a', context('parent-2'))

      const outcome = await runtime.wait('parent-1', { runIds: [foreign] })

      expect(outcome.ok).toBe(false)
      runtime.dispose()
    })
  })

  describe('files changed', () => {
    it('lists the files the run wrote in its result, its wait entry, and its settle callback', async () => {
      const journal = createWorkspaceJournal()
      const store = new AgentRunStore()
      const toolRegistry = new ToolRegistry()
      toolRegistry.registerProvider({
        names: ['write_file'],
        isAvailable: () => true,
        create: (name, ports) =>
          tool({
            description: name,
            inputSchema: jsonSchema({ type: 'object' }),
            execute: async () => {
              ports.journal?.record({ kind: 'write', path: 'src/a.ts', before: null, after: 'a' })
              return 'written'
            },
          }),
      })
      const model = new MockLanguageModelV4({
        doStream: [{ stream: toolStep('c1', 'write_file') }, { stream: textStep('t2', 'done') }],
      })
      const onSettle = vi.fn()
      const runtime = createAgentRuntime({
        getSettings: () => defaultSettings(),
        skillRegistry: new SkillRegistry(skillStore),
        toolRegistry,
        store,
        modelFactory: () => model as unknown as LanguageModel,
        portsFor: (_context, runId) => ({ journal: runId ? tagJournal(journal, runId) : journal }) as ToolRuntimePorts,
        onSettle,
      })
      journal.record({ kind: 'write', path: 'parent.ts', before: null, after: 'p' })

      const outcome = await runtime.spawn(
        { ...context(), mode: 'god', toolNames: ['write_file'] },
        { prompt: 'write', mode: 'god', tier: 'high', background: true },
      )
      if (outcome.status !== 'running') throw new Error('expected a background run')
      const gathered = await runtime.wait('parent-1', { runIds: [outcome.runId] })

      expect(store.get(outcome.runId)?.result?.filesChanged).toEqual(['src/a.ts'])
      expect(store.get(outcome.runId)?.result?.filesChangedIncomplete).toBeUndefined()
      if (!gathered.ok) throw new Error(gathered.message)
      expect(gathered.runs[0].filesChanged).toEqual(['src/a.ts'])
      expect(onSettle).not.toHaveBeenCalled()
    })

    it('says the list is incomplete when the journal has already dropped some of the run\'s writes', async () => {
      const journal = createWorkspaceJournal()
      const toolRegistry = new ToolRegistry()
      toolRegistry.registerProvider({
        names: ['write_file'],
        isAvailable: () => true,
        create: (name, ports) =>
          tool({
            description: name,
            inputSchema: jsonSchema({ type: 'object' }),
            execute: async () => {
              ports.journal?.record({ kind: 'write', path: 'src/early.ts', before: null, after: 'a' })
              for (let index = 0; index < 500; index += 1) {
                journal.record({ kind: 'write', path: `other-${index}.ts`, before: null, after: 'o' })
              }
              return 'written'
            },
          }),
      })
      const model = new MockLanguageModelV4({
        doStream: [{ stream: toolStep('c1', 'write_file') }, { stream: textStep('t2', 'done') }],
      })
      const runtime = createAgentRuntime({
        getSettings: () => defaultSettings(),
        skillRegistry: new SkillRegistry(skillStore),
        toolRegistry,
        store: new AgentRunStore(),
        modelFactory: () => model as unknown as LanguageModel,
        portsFor: (_context, runId) => ({ journal: runId ? tagJournal(journal, runId) : journal }) as ToolRuntimePorts,
      })

      const outcome = await runtime.spawn(
        { ...context(), mode: 'god', toolNames: ['write_file'] },
        { prompt: 'write', mode: 'god', tier: 'high' },
      )

      if (outcome.status !== 'completed') throw new Error('expected an awaited run')
      expect(outcome.result.filesChanged).toBeUndefined()
      expect(outcome.result.filesChangedIncomplete).toBe(true)
    })
  })
})
