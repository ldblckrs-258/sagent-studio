import type { LanguageModel, UIMessage } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createEngine } from '../chat/engine'
import type { EngineDeps, ThreadStore } from '../chat/engine'
import { rehydrateThread } from '../chat/sanitize'
import { useChatStore } from '../chat/store'
import { defaultThreadConfig } from '../chat/types'
import type { AgentNoticeReport, ChatThread } from '../chat/types'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { createAgentsToolProvider } from '../tools/builtin/agents'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts } from '../tools/types'
import { deepMerge, defaultSettings } from '../vault/settings'
import type { Settings } from '../vault/settings'
import { createAgentRuntime } from './runtime'
import type { AgentRunPersistence, AgentRunSnapshot } from './runtime'
import { AgentRunStore } from './store'
import type { AgentRunRecord } from './store'
import { summarizeAgentResult } from './types'
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

function heldTextStream(
  id: string,
  delta: string,
  gate: Promise<void>,
  onStarted: () => void,
): ReadableStream<Chunk> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'text-start', id })
      controller.enqueue({ type: 'text-delta', id, delta })
      onStarted()
      await gate
      controller.enqueue({ type: 'text-end', id })
      controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } })
      controller.close()
    },
  })
}

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

function childThreadFrom(snapshot: AgentRunSnapshot): ChatThread {
  return {
    id: snapshot.runId,
    title: snapshot.label?.trim() || 'Agent run',
    messages: snapshot.messages,
    config: defaultThreadConfig(snapshot.providerId, snapshot.modelId),
    mode: snapshot.mode,
    createdAt: snapshot.startedAt,
    updatedAt: Date.now(),
    agent: {
      runId: snapshot.runId,
      parentThreadId: snapshot.parentThreadId,
      ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
      mode: snapshot.mode,
      tier: snapshot.tier,
      status: snapshot.status,
      ...(snapshot.stopReason !== undefined ? { stopReason: snapshot.stopReason } : {}),
    },
  }
}

function firstUserText(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === 'user')
  if (!first) return ''
  return first.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

function snapshotFromThread(thread: ChatThread): AgentRunSnapshot | null {
  const meta = thread.agent
  if (!meta) return null
  return {
    runId: meta.runId,
    parentThreadId: meta.parentThreadId,
    providerId: thread.config.providerId,
    ...(thread.config.modelId !== undefined ? { modelId: thread.config.modelId } : {}),
    mode: meta.mode,
    tier: meta.tier,
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    status: meta.status,
    ...(meta.stopReason !== undefined ? { stopReason: meta.stopReason } : {}),
    prompt: firstUserText(thread.messages),
    messages: thread.messages,
    startedAt: thread.createdAt,
  }
}

function noticeFor(run: AgentRunRecord): { text: string; report: AgentNoticeReport } {
  const status = run.result?.status ?? run.status
  const stopReason = run.result?.stopReason ?? run.stopReason
  const suffix = run.label !== undefined ? ` "${run.label}"` : ''
  if (status === 'stopped') {
    return {
      text: `Sub-agent${suffix} stopped by the user.`,
      report: {
        status,
        response: `The user stopped the sub-agent${suffix}.`,
        ...(run.label !== undefined ? { label: run.label } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      },
    }
  }
  const response = run.result ? summarizeAgentResult(run.result) : `The agent ${run.status}.`
  return {
    text: `Sub-agent${suffix} finished: ${response}`,
    report: {
      status,
      response,
      ...(run.label !== undefined ? { label: run.label } : {}),
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

function build(options: {
  settings: Settings
  modelFactory: EngineDeps['modelFactory']
  onSettled?: () => void
}) {
  const store = new AgentRunStore()
  const toolRegistry = new ToolRegistry()
  toolRegistry.registerProvider(recorderProvider())
  toolRegistry.registerProvider(createAgentsToolProvider())

  const threads = new Map<string, ChatThread>()
  const threadStore: ThreadStore = {
    loadThread: async (id) => threads.get(id) ?? null,
    saveThread: async (thread) => {
      threads.set(thread.id, thread)
    },
    listThreads: async () => [],
    deleteThread: async (id) => {
      threads.delete(id)
    },
  }

  const persistence: AgentRunPersistence = {
    create: async (snapshot) => {
      threads.set(snapshot.runId, childThreadFrom(snapshot))
    },
    save: async (snapshot) => {
      threads.set(snapshot.runId, childThreadFrom(snapshot))
    },
    load: async (runId) => {
      const thread = threads.get(runId)
      return thread ? snapshotFromThread(thread) : null
    },
    list: async (parentThreadId) =>
      [...threads.values()]
        .filter((thread) => thread.agent?.parentThreadId === parentThreadId)
        .map((thread) => snapshotFromThread(thread))
        .filter((snapshot): snapshot is AgentRunSnapshot => snapshot !== null),
  }

  const deps: EngineDeps = {
    getSettings: () => options.settings,
    skillRegistry: new SkillRegistry(skillStore),
    toolRegistry,
    threadStore,
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
    persistence,
    ...(options.modelFactory ? { modelFactory: options.modelFactory } : {}),
    portsFor: () => ({}) as ToolRuntimePorts,
    onSettle: (run) => {
      const notice = noticeFor(run)
      engine.appendAgentNotice(run.parentThreadId, notice.text, run.runId, notice.report)
      options.onSettled?.()
    },
  })
  return { engine, store, runtime, threads, threadStore }
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

function parentContext(): AgentParentContext {
  return {
    parentThreadId: 'th1',
    mode: 'god',
    toolNames: [],
    providerId: 'parent',
    modelId: 'm1',
    systemInstruction: '',
  }
}

function noticePartOf(message: UIMessage): { data: Record<string, unknown> } | undefined {
  return message.parts.find((part) => part.type === 'data-agent-notice') as
    | { data: Record<string, unknown> }
    | undefined
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

  it('renders a background notice inline when it arrives mid-turn', async () => {
    let releaseParent!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const sub = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('s1', 'background result')) }] })
    const parent = new MockLanguageModelV4({
      doStream: [
        {
          stream: streamOf(
            toolStep('c1', 'spawn_agent', {
              prompt: 'research the topic',
              mode: 'god',
              tier: 'cheap',
              background: true,
            }),
          ),
        },
        { stream: heldTextStream('t2', 'parent ', parentGate, () => {}) },
      ],
    })
    const { engine } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: (_settings, providerId) =>
        (providerId === 'sub' ? sub : parent) as unknown as LanguageModel,
      onSettled: settle,
    })
    seed()

    const turn = engine.sendTurn('th1', 'delegate in the background')
    await settled

    // The child settled while the parent turn was still streaming, so the notice
    // lands as an inline data part on that assistant message.
    const streaming = useChatStore.getState().threads.th1.messages.at(-1)!
    expect(streaming.metadata).toMatchObject({ chatStatus: 'streaming' })
    expect(noticePartOf(streaming)?.data).toMatchObject({ status: 'completed' })
    expect(String(noticePartOf(streaming)?.data.text)).toContain('background result')
    expect(agentSpawnParts()[0].output?.value?.status).toBe('running')
    // No standalone notice message was appended.
    expect(
      useChatStore
        .getState()
        .threads.th1.messages.some((m: UIMessage) => (m.metadata as { agentNotice?: boolean })?.agentNotice === true),
    ).toBe(false)

    releaseParent()
    await turn

    // The notice survives the remaining chunks and the final write in place.
    const settledMessage = useChatStore.getState().threads.th1.messages.at(-1)!
    expect(settledMessage.id).toBe(streaming.id)
    expect(settledMessage.metadata).toMatchObject({ chatStatus: 'done' })
    expect(noticePartOf(settledMessage)?.data).toMatchObject({ status: 'completed' })
  })

  it('keeps a mid-turn notice where it arrived as later parts stream in', async () => {
    let releaseParent!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const sub = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('s1', 'background result')) }] })
    const parent = new MockLanguageModelV4({
      doStream: [
        {
          stream: streamOf(
            toolStep('c1', 'spawn_agent', {
              prompt: 'research the topic',
              mode: 'god',
              tier: 'cheap',
              background: true,
            }),
          ),
        },
        {
          stream: new ReadableStream<Chunk>({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't2' })
              controller.enqueue({ type: 'text-delta', id: 't2', delta: 'before the notice' })
              controller.enqueue({ type: 'text-end', id: 't2' })
              await parentGate
              controller.enqueue({ type: 'text-start', id: 't3' })
              controller.enqueue({ type: 'text-delta', id: 't3', delta: 'after the notice' })
              controller.enqueue({ type: 'text-end', id: 't3' })
              controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } })
              controller.close()
            },
          }),
        },
      ],
    })
    const { engine } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: (_settings, providerId) =>
        (providerId === 'sub' ? sub : parent) as unknown as LanguageModel,
      onSettled: settle,
    })
    seed()

    const turn = engine.sendTurn('th1', 'delegate in the background')
    await settled
    releaseParent()
    await turn

    const parts = useChatStore.getState().threads.th1.messages.at(-1)!.parts
    const index = (predicate: (part: UIMessage['parts'][number]) => boolean) => parts.findIndex(predicate)
    const before = index((part) => part.type === 'text' && part.text === 'before the notice')
    const notice = index((part) => part.type === 'data-agent-notice')
    const after = index((part) => part.type === 'text' && part.text === 'after the notice')
    expect(before).toBeGreaterThanOrEqual(0)
    expect(notice).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(notice)
  })

  it('appends a standalone notice when the thread is idle', async () => {
    const { engine, threadStore } = build({
      settings: settingsWith({}),
      modelFactory: () => ({} as LanguageModel),
    })
    seed()

    engine.appendAgentNotice('th1', 'Sub-agent finished: done', 'run-idle')

    const messages = useChatStore.getState().threads.th1.messages
    expect(messages).toHaveLength(1)
    const notice = messages[0]
    expect(notice.metadata).toMatchObject({ agentNotice: true, untrusted: true, runId: 'run-idle' })
    expect(noticePartOf(notice)?.data).toMatchObject({ text: 'Sub-agent finished: done', runId: 'run-idle' })

    const persisted = await threadStore.loadThread('th1')
    expect(persisted?.messages.map((message) => message.id)).toEqual([notice.id])
  })

  it('steers, stops, and reads a background run', async () => {
    let childCalls = 0
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let secondStarted!: () => void
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const sub = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        childCalls += 1
        if (childCalls === 1) {
          return { stream: heldTextStream('s1', 'child start', firstGate, firstStarted) }
        }
        secondStarted()
        return { stream: pendingStream(abortSignal) }
      },
    })
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const { runtime, store, threads } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: () => sub as unknown as LanguageModel,
      onSettled: settle,
    })
    seed()

    const outcome = await runtime.spawn(parentContext(), {
      prompt: 'investigate',
      mode: 'god',
      tier: 'cheap',
      background: true,
      label: 'audit',
    })
    expect(outcome.status).toBe('running')
    if (outcome.status !== 'running') return
    const runId = outcome.runId

    // Steer while the first model turn is held, then let it finish so the
    // steering message is delivered in a continuation pass.
    await firstStartedPromise
    expect(runtime.steer('th1', runId, 'dig deeper')).toBe(true)
    releaseFirst()
    await secondStartedPromise
    expect(childCalls).toBe(2)

    expect(runtime.stop('th1', runId)).toBe(true)
    await settled

    const record = store.get(runId)
    expect(record?.status).toBe('stopped')
    expect(record?.stopReason).toBe('user_stop')

    // The persisted child thread carries the same stopped outcome.
    const child = threads.get(runId)
    expect(child?.agent?.status).toBe('stopped')
    expect(child?.agent?.stopReason).toBe('user_stop')

    const notices = useChatStore
      .getState()
      .threads.th1.messages.filter((m: UIMessage) => (m.metadata as { agentNotice?: boolean })?.agentNotice === true)
    expect(notices).toHaveLength(1)
    expect(noticePartOf(notices[0])?.data).toMatchObject({
      runId,
      status: 'stopped',
      stopReason: 'user_stop',
    })
    expect(String(noticePartOf(notices[0])?.data.text)).toContain('stopped')

    const transcript = await runtime.read('th1', runId)
    expect(transcript?.status).toBe('stopped')
    expect(transcript?.stopReason).toBe('user_stop')
    expect(
      transcript?.turns.filter((turn) => turn.role === 'user' && turn.text === 'dig deeper'),
    ).toHaveLength(1)

    const lastTwo = await runtime.read('th1', runId, { lastN: 2 })
    expect(lastTwo?.turns).toHaveLength(2)
    expect(lastTwo?.turns.at(-1)).toEqual({ role: 'user', text: 'dig deeper' })

    // Every control method is scoped to the calling conversation.
    await expect(runtime.read('other', runId)).resolves.toBeNull()
    await expect(runtime.resolveRun('other', { runId })).resolves.toBeNull()
  })

  it('persists each child tool call with its real result, so a reload shows it', async () => {
    const sub = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('k1', 'read_file', { path: 'a' })) },
        { stream: streamOf(textStep('s2', 'done')) },
      ],
    })
    const { runtime, threads, store } = build({
      settings: settingsWith({ cheap: { providerId: 'sub', modelId: 'm' } }),
      modelFactory: () => sub as unknown as LanguageModel,
    })

    const outcome = await runtime.spawn(
      { ...parentContext(), toolNames: ['read_file'] },
      { prompt: 'go', mode: 'god', tier: 'cheap' },
      {},
    )
    const runId = (outcome as { runId: string }).runId
    const persisted = threads.get(runId)
    expect(persisted).toBeDefined()
    const reloaded = rehydrateThread(persisted as ChatThread)
    const toolPart = reloaded.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-read_file') as unknown as { state: string; output: unknown }

    expect(toolPart).toMatchObject({ state: 'output-available', output: 'file contents' })
    expect(reloaded.messages).toEqual(store.get(runId)?.messages)
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
