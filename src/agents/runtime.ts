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
  AgentReadOptions,
  AgentRequest,
  AgentRunIdentity,
  AgentRunIdentifier,
  AgentRunResult,
  AgentSpawnOptions,
  AgentSpawnOutcome,
  AgentSteeringControl,
  AgentStopReason,
  AgentTranscript,
  AgentTurn,
} from './types'

/** Clamps `lastN`; defaults to 6 and never exceeds 50 turns. */
const DEFAULT_READ_TURNS = 6
const MAX_READ_TURNS = 50

export interface AgentRunSnapshot {
  runId: string
  parentThreadId: string
  providerId: string
  modelId?: string
  mode: ChatMode
  tier: ModelTier
  label?: string
  status: AgentRunStatus
  stopReason?: AgentStopReason
  prompt: string
  messages: UIMessage[]
  startedAt: number
}

/** Persists a delegated run as a child agent thread and reads it back. */
export interface AgentRunPersistence {
  create(snapshot: AgentRunSnapshot): Promise<void>
  save(snapshot: AgentRunSnapshot): Promise<void>
  /** Loads one settled child run, or null when it is absent. */
  load(runId: string): Promise<AgentRunSnapshot | null>
  /** Lists a parent's settled child runs, newest first. */
  list(parentThreadId: string): Promise<AgentRunSnapshot[]>
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
  /** Enqueues a steering turn, guarded by the caller's parent thread. */
  steer(parentThreadId: string, runId: string, text: string): boolean
  /** Force-stops a live run, guarded by the caller's parent thread. */
  stop(parentThreadId: string, runId: string, reason?: AgentStopReason): boolean
  /** Reads a live or settled run, guarded by the caller's parent thread. */
  read(
    parentThreadId: string,
    runId: string,
    options?: AgentReadOptions,
  ): Promise<AgentTranscript | null>
  /** Resolves a runId or a unique label within the caller's parent thread. */
  resolveRun(
    parentThreadId: string,
    identifier: AgentRunIdentifier,
  ): Promise<AgentRunIdentity | null>
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * One control per run, built over its controller. `requestStop` records the
 * reason and aborts, so the runner observes `stopRequested()` at abort time.
 * `close` is what the runner calls once it stops draining, so `steer` can stop
 * accepting turns that would never be delivered.
 */
function createSteeringControl(controller: AbortController): AgentSteeringControl {
  const pending: string[] = []
  let requested = false
  let reason: AgentStopReason | undefined
  let closed = false
  return {
    enqueue(text) {
      pending.push(text)
    },
    drain() {
      return pending.splice(0, pending.length)
    },
    requestStop(next) {
      if (requested) return
      requested = true
      reason = next
      controller.abort()
    },
    stopRequested() {
      return requested
    },
    stopReason() {
      return reason
    },
    accepting() {
      return !closed
    },
    close() {
      closed = true
    },
  }
}

/** Projects a child run's messages into turns, oldest first. */
function turnsFromMessages(messages: UIMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    let text = ''
    const flush = (): void => {
      if (text.length === 0) return
      turns.push({ role: message.role === 'user' ? 'user' : 'assistant', text })
      text = ''
    }
    for (const part of message.parts) {
      const type = (part as { type?: string }).type
      if (type === 'text') {
        text += (part as { text: string }).text
      } else if (type === 'dynamic-tool' || type?.startsWith('tool-')) {
        flush()
        const toolName =
          (part as { toolName?: string }).toolName ??
          (typeof type === 'string' && type !== 'dynamic-tool' ? type.slice(5) : '')
        turns.push({
          role: 'tool',
          text: '',
          ...(toolName ? { toolName } : {}),
        })
      }
    }
    flush()
  }
  return turns
}

function clampLastN(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_READ_TURNS
  return Math.min(MAX_READ_TURNS, Math.max(1, Math.floor(value)))
}

/** Applies `lastN` and `includeTools` to a turn list, oldest-first. */
function projectTranscript(
  runId: string,
  turns: AgentTurn[],
  status: AgentRunStatus,
  options: AgentReadOptions,
  label?: string,
  stopReason?: AgentStopReason,
): AgentTranscript {
  const visible =
    options.includeTools === true ? turns : turns.filter((turn) => turn.role !== 'tool')
  const lastN = clampLastN(options.lastN)
  return {
    runId,
    ...(label !== undefined ? { label } : {}),
    status,
    ...(stopReason !== undefined ? { stopReason } : {}),
    turns: visible.slice(Math.max(0, visible.length - lastN)),
  }
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const controllers = new Map<string, AbortController>()
  const parents = new Map<string, string>()
  const lastPersist = new Map<string, number>()
  const saves = new Map<string, Promise<void>>()

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
    ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
    prompt,
    messages: record.messages,
    startedAt: record.startedAt,
  })

  const persist = async (
    kind: 'create' | 'save',
    record: AgentRunRecord,
    context: AgentParentContext,
    prompt: string,
    status: AgentRunStatus,
  ): Promise<void> => {
    const persistence = deps.persistence
    if (!persistence) return
    const snapshot = snapshotOf(record, context, prompt, status)
    const previous = saves.get(record.runId) ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        if (kind === 'create') await persistence.create(snapshot)
        else await persistence.save(snapshot)
      } catch {
        // Persistence is best-effort; a locked vault must not fail the run.
      }
    })
    saves.set(record.runId, next)
    await next
    if (saves.get(record.runId) === next) saves.delete(record.runId)
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

  const loadPersisted = async (runId: string): Promise<AgentRunSnapshot | null> => {
    if (!deps.persistence) return null
    try {
      return await deps.persistence.load(runId)
    } catch {
      // A locked vault or a mid-save row yields no run rather than throwing.
      return null
    }
  }

  const listPersisted = async (parentThreadId: string): Promise<AgentRunSnapshot[]> => {
    if (!deps.persistence) return []
    try {
      return await deps.persistence.list(parentThreadId)
    } catch {
      return []
    }
  }

  const identityOf = (run: AgentRunRecord | AgentRunSnapshot): AgentRunIdentity => ({
    runId: run.runId,
    ...(run.label !== undefined ? { label: run.label } : {}),
    status: run.status,
  })

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

      const steering = createSteeringControl(controller)
      deps.store.attachSteering(runId, steering)

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
        messages: [
          { id: `${runId}-prompt`, role: 'user', parts: [{ type: 'text', text: request.prompt }] },
        ],
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
        steering,
      }

      const onMessages = (messages: UIMessage[]) => {
        deps.store.setMessages(runId, messages)
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
        deps.store.detachSteering(runId)
        controllers.delete(runId)
        parents.delete(runId)
        lastPersist.delete(runId)
      }

      const run = runAgent({ runId, request, parent: context }, runnerDeps, controller.signal, onMessages)

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
      return { status: 'completed', runId, ...(label !== undefined ? { label } : {}), result }
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

    steer(parentThreadId, runId, text) {
      if (parents.get(runId) !== parentThreadId) return false
      return deps.store.steer(runId, text)
    },

    stop(parentThreadId, runId, reason = 'user_stop') {
      if (parents.get(runId) !== parentThreadId) return false
      const stopped = deps.store.requestStop(runId, reason)
      if (stopped) controllers.get(runId)?.abort()
      return stopped
    },

    async read(parentThreadId, runId, options = {}) {
      const record = deps.store.get(runId)
      if (record) {
        if (record.parentThreadId !== parentThreadId) return null
        return projectTranscript(
          record.runId,
          turnsFromMessages(record.messages),
          record.status,
          options,
          record.label,
          record.stopReason,
        )
      }
      const snapshot = await loadPersisted(runId)
      if (!snapshot || snapshot.parentThreadId !== parentThreadId) return null
      return projectTranscript(
        snapshot.runId,
        turnsFromMessages(snapshot.messages),
        snapshot.status,
        options,
        snapshot.label,
        snapshot.stopReason,
      )
    },

    async resolveRun(parentThreadId, identifier) {
      if (identifier.runId) {
        const record = deps.store.get(identifier.runId)
        if (record) return record.parentThreadId === parentThreadId ? identityOf(record) : null
        const snapshot = await loadPersisted(identifier.runId)
        if (!snapshot) return null
        return snapshot.parentThreadId === parentThreadId ? identityOf(snapshot) : null
      }
      if (!identifier.label) return null
      const live = deps.store.list(parentThreadId)
      const seen = new Set(live.map((run) => run.runId))
      const persisted = (await listPersisted(parentThreadId)).filter(
        (snapshot) => !seen.has(snapshot.runId),
      )
      const matches = [
        ...live
          .filter((run) => run.label === identifier.label)
          .map((run) => identityOf(run)),
        ...persisted
          .filter((snapshot) => snapshot.label === identifier.label)
          .map((snapshot) => identityOf(snapshot)),
      ]
      return matches.length === 1 ? matches[0] : null
    },
  }
}
