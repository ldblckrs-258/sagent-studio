import type { UIMessage } from 'ai'
import type { AgentRunStatus, ChatMode } from '../chat/types'
import { registerAbortAll } from '../chat/store'
import type { SkillRegistry } from '../skills/registry'
import type { ToolRegistry } from '../tools/registry'
import type { ToolRuntimePorts } from '../tools/types'
import type { ModelFactory } from '../ai/model-tier'
import type { ModelTier, Settings } from '../vault/settings'
import { createApprovalQueue } from './approval-queue'
import { MAX_AGENTS_PER_THREAD, MAX_CONCURRENT_AGENTS, runAgent } from './runner'
import type { AgentRunStore, AgentRunRecord } from './store'
import type {
  AgentParentContext,
  AgentRequest,
  AgentRunEvent,
  AgentRunResult,
  AgentSpawnOptions,
  AgentSpawnOutcome,
} from './types'

export interface AgentRunSnapshot {
  runId: string
  parentThreadId: string
  providerId: string
  modelId?: string
  mode: ChatMode
  tier: ModelTier
  label?: string
  status: AgentRunStatus
  prompt: string
  messages: UIMessage[]
  startedAt: number
}

/** Persists a delegated run as a child agent thread. */
export interface AgentRunPersistence {
  create(snapshot: AgentRunSnapshot): Promise<void>
  save(snapshot: AgentRunSnapshot): Promise<void>
}

export interface AgentRuntimeDeps {
  getSettings(): Settings | null
  skillRegistry: SkillRegistry
  toolRegistry: ToolRegistry
  /**
   * Builds the delegated tool ports, mirroring the parent run's own ports. May
   * be async so the parent thread's journal can be resolved before the run.
   */
  portsFor(context: AgentParentContext): ToolRuntimePorts | Promise<ToolRuntimePorts>
  store: AgentRunStore
  modelFactory?: ModelFactory
  persistence?: AgentRunPersistence
  /** Called once when a background run settles. */
  onSettle?(run: AgentRunRecord, result: AgentRunResult): void
}

export interface AgentRuntime {
  spawn(
    context: AgentParentContext,
    request: AgentRequest,
    options?: AgentSpawnOptions,
  ): Promise<AgentSpawnOutcome>
  cancel(runId: string): void
  abortThread(threadId: string): void
  abortAll(): void
  dispose(): void
  activeCount(): number
  activeForThread(threadId: string): number
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Builds a durable transcript: the prompt and the assistant's streamed text. */
function transcript(prompt: string, record: AgentRunRecord): UIMessage[] {
  const parts: UIMessage['parts'] = []
  for (const event of record.events) {
    if (event.type === 'text-delta') {
      parts.push({ type: 'text', text: event.text })
    } else if (event.type === 'tool-call') {
      parts.push({ type: 'text', text: `\n[called ${event.toolName}]\n` })
    }
  }
  return [
    { id: `${record.runId}-prompt`, role: 'user', parts: [{ type: 'text', text: prompt }] },
    {
      id: `${record.runId}-result`,
      role: 'assistant',
      parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
      metadata: { chatStatus: 'done' },
    },
  ]
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const controllers = new Map<string, AbortController>()
  const parents = new Map<string, string>()
  const lastPersist = new Map<string, number>()

  const snapshotOf = (
    record: AgentRunRecord,
    context: AgentParentContext,
    prompt: string,
    status: AgentRunStatus,
  ): AgentRunSnapshot => ({
    runId: record.runId,
    parentThreadId: record.parentThreadId,
    providerId: context.providerId,
    ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
    mode: record.mode,
    tier: record.tier,
    ...(record.label !== undefined ? { label: record.label } : {}),
    status,
    prompt,
    messages: transcript(prompt, record),
    startedAt: record.startedAt,
  })

  const persist = async (
    kind: 'create' | 'save',
    record: AgentRunRecord,
    context: AgentParentContext,
    prompt: string,
    status: AgentRunStatus,
  ): Promise<void> => {
    if (!deps.persistence) return
    const snapshot = snapshotOf(record, context, prompt, status)
    try {
      if (kind === 'create') await deps.persistence.create(snapshot)
      else await deps.persistence.save(snapshot)
    } catch {
      // Persistence is best-effort; a locked vault must not fail the run.
    }
  }

  const limit = (scope: 'concurrent' | 'thread'): AgentSpawnOutcome => ({
    status: 'limit_exceeded',
    message:
      scope === 'concurrent'
        ? `At most ${MAX_CONCURRENT_AGENTS} agents may run at once.`
        : `At most ${MAX_AGENTS_PER_THREAD} agents may run per conversation.`,
  })

  const abortAll = (): void => {
    for (const controller of controllers.values()) controller.abort()
  }

  const unregister = registerAbortAll(abortAll)

  return {
    async spawn(context, request, options = {}) {
      const background = options.background ?? request.background ?? false
      const label = options.label ?? request.label
      if (controllers.size >= MAX_CONCURRENT_AGENTS) return limit('concurrent')
      let sameThread = 0
      for (const threadId of parents.values()) {
        if (threadId === context.parentThreadId) sameThread += 1
      }
      if (sameThread >= MAX_AGENTS_PER_THREAD) return limit('thread')

      const runId = createRunId()
      const controller = new AbortController()
      controllers.set(runId, controller)
      parents.set(runId, context.parentThreadId)

      const queue = createApprovalQueue({
        signal: controller.signal,
        onRequest: (entry) => deps.store.addApproval(runId, entry),
      })
      deps.store.attachQueue(runId, queue)

      const record: AgentRunRecord = {
        runId,
        parentThreadId: context.parentThreadId,
        ...(label !== undefined ? { label } : {}),
        mode: context.mode,
        tier: request.tier,
        status: 'running',
        prompt: request.prompt,
        events: [],
        text: '',
        toolCalls: 0,
        approvals: [],
        startedAt: Date.now(),
      }
      deps.store.register(record)
      lastPersist.set(runId, Date.now())
      await persist('create', record, context, request.prompt, 'running')

      const runnerDeps = {
        settings: deps.getSettings(),
        skillRegistry: deps.skillRegistry,
        toolRegistry: deps.toolRegistry,
        ports: await deps.portsFor(context),
        ...(deps.modelFactory ? { modelFactory: deps.modelFactory } : {}),
        queue,
      }

      const onEvent = (event: AgentRunEvent) => {
        deps.store.appendEvent(runId, event)
        const now = Date.now()
        const previous = lastPersist.get(runId) ?? 0
        if (now - previous > 400) {
          lastPersist.set(runId, now)
          const current = deps.store.get(runId)
          if (current) void persist('save', current, context, request.prompt, current.status)
        }
      }

      const cleanup = (): void => {
        deps.store.detachQueue(runId)
        controllers.delete(runId)
        parents.delete(runId)
        lastPersist.delete(runId)
      }

      const run = runAgent({ runId, request, parent: context }, runnerDeps, controller.signal, onEvent)

      if (background) {
        void run
          .then(async (result) => {
            deps.store.finish(runId, result)
            const current = deps.store.get(runId) ?? record
            await persist('save', current, context, request.prompt, result.status)
            cleanup()
            deps.onSettle?.(current, result)
          })
          .catch(() => {
            cleanup()
          })
        return { status: 'running', runId, ...(label !== undefined ? { label } : {}) }
      }

      const result = await run
      deps.store.finish(runId, result)
      const current = deps.store.get(runId) ?? record
      await persist('save', current, context, request.prompt, result.status)
      cleanup()
      return { status: 'completed', ...(label !== undefined ? { label } : {}), result }
    },

    cancel(runId) {
      controllers.get(runId)?.abort()
    },

    abortThread(threadId) {
      for (const [runId, parentThreadId] of parents) {
        if (parentThreadId === threadId) controllers.get(runId)?.abort()
      }
    },

    abortAll,

    dispose() {
      unregister()
      abortAll()
      controllers.clear()
      parents.clear()
      lastPersist.clear()
    },

    activeCount: () => controllers.size,

    activeForThread(threadId) {
      let count = 0
      for (const parentThreadId of parents.values()) {
        if (parentThreadId === threadId) count += 1
      }
      return count
    },
  }
}
