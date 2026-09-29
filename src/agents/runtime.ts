import type { UIMessage } from 'ai'
import type { AgentRunStatus, ChatMode } from '../chat/types'
import { loadProjectInstruction } from '../chat/project-instruction'
import { registerAbortAll } from '../chat/store'
import type { SkillRegistry } from '../skills/registry'
import type { ToolRegistry } from '../tools/registry'
import type { ToolRuntimePorts } from '../tools/types'
import type { ModelFactory } from '../ai/model-tier'
import type { ModelTier, Settings } from '../vault/settings'
import { createApprovalQueue } from './approval-queue'
import { applyAgentProfile } from './profiles'
import type { AgentProfile } from './profiles'
import {
  isCompactionMessage,
  nextPassIndex,
  openingMessages,
  promptMessage,
  repairLegacyRunMessages,
  toolCallCount,
} from './run-transcript'
import type { RunSeed } from './run-transcript'
import { MAX_AGENTS_PER_THREAD, MAX_CONCURRENT_AGENTS, runAgent } from './runner'
import type { AgentRunStore, AgentRunRecord } from './store'
import type {
  AgentContinueOptions,
  AgentParentContext,
  AgentReadOptions,
  AgentRequest,
  AgentRunIdentity,
  AgentRunIdentifier,
  AgentRunResult,
  AgentRunSpec,
  AgentSpawnOptions,
  AgentSpawnOutcome,
  AgentSpawnRequest,
  AgentSteeringControl,
  AgentStopReason,
  AgentTranscript,
  AgentTurn,
  AgentWaitOptions,
  AgentWaitOutcome,
  AgentWaitRun,
} from './types'
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, summarizeAgentResult } from './types'

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
  profile?: string
  status: AgentRunStatus
  stopReason?: AgentStopReason
  prompt: string
  messages: UIMessage[]
  startedAt: number
  spec?: AgentRunSpec
}

export interface AgentProfileLookup {
  get(id: string): AgentProfile | undefined
  list(): AgentProfile[]
  refresh?(): Promise<void>
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
  portsFor(context: AgentParentContext, runId?: string): ToolRuntimePorts | Promise<ToolRuntimePorts>
  store: AgentRunStore
  profiles?: AgentProfileLookup
  modelFactory?: ModelFactory
  persistence?: AgentRunPersistence
  /** Called once when a background run settles. */
  onSettle?(run: AgentRunRecord, result: AgentRunResult): void
}

export interface AgentRuntime {
  spawn(
    context: AgentParentContext,
    request: AgentSpawnRequest,
    options?: AgentSpawnOptions,
  ): Promise<AgentSpawnOutcome>
  continue(
    context: AgentParentContext,
    runId: string,
    text: string,
    options?: AgentContinueOptions,
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
  profiles(): AgentProfile[]
  wait(parentThreadId: string, options: AgentWaitOptions, signal?: AbortSignal): Promise<AgentWaitOutcome>
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

function specOf(request: AgentRequest, context: AgentParentContext): AgentRunSpec {
  return {
    mode: request.mode,
    toolNames: [...context.toolNames],
    ...(request.agent !== undefined ? { profile: request.agent } : {}),
    ...(request.skills ? { skills: [...request.skills] } : {}),
    ...(request.excludeTools ? { excludeTools: [...request.excludeTools] } : {}),
    ...(request.allowTools ? { allowTools: [...request.allowTools] } : {}),
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
  }
}

/** Projects a child run's messages into turns, oldest first. */
function turnsFromMessages(messages: UIMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (isCompactionMessage(message)) continue
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
  const reserved = new Map<string, string>()
  const settlers = new Map<string, Promise<void>>()
  const collected = new Set<string>()
  const waiting = new Map<string, number>()
  const gathered = new Map<string, () => void>()
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
    ...(record.profile !== undefined ? { profile: record.profile } : {}),
    status,
    ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
    prompt,
    messages: record.messages,
    startedAt: record.startedAt,
    ...(record.spec !== undefined ? { spec: record.spec } : {}),
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

  const resolveRunIn = async (
    parentThreadId: string,
    identifier: AgentRunIdentifier,
  ): Promise<AgentRunIdentity | null> => {
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
  }

  const limitFor = (parentThreadId: string): AgentSpawnOutcome | null => {
    if (controllers.size + reserved.size >= MAX_CONCURRENT_AGENTS) return limit('concurrent')
    let sameThread = 0
    for (const threadId of [...parents.values(), ...reserved.values()]) {
      if (threadId === parentThreadId) sameThread += 1
    }
    return sameThread >= MAX_AGENTS_PER_THREAD ? limit('thread') : null
  }

  const launch = async (input: {
    context: AgentParentContext
    request: AgentRequest
    record: AgentRunRecord
    background: boolean
    kind: 'create' | 'save'
    profile?: AgentProfile
    ports?: ToolRuntimePorts
    seed?: RunSeed
  }): Promise<AgentSpawnOutcome> => {
    const { context, request, record, background } = input
    const runId = record.runId
    const label = record.label
    const controller = new AbortController()
    controllers.set(runId, controller)
    parents.set(runId, context.parentThreadId)
    let resolveSettled = (): void => {}
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    settlers.set(runId, settled)
    const markSettled = (): void => {
      if (settlers.get(runId) === settled) settlers.delete(runId)
      resolveSettled()
    }

    const steering = createSteeringControl(controller)
    deps.store.attachSteering(runId, steering)

    const queue = createApprovalQueue({
      signal: controller.signal,
      onRequest: (entry) => deps.store.addApproval(runId, entry),
    })
    deps.store.attachQueue(runId, queue)

    deps.store.register(record)
    lastPersist.set(runId, Date.now())
    await persist(input.kind, record, context, request.prompt, 'running')

    const ports = input.ports ?? (await deps.portsFor(context, runId))
    const withFiles = (result: AgentRunResult): AgentRunResult => {
      const filesChanged = ports.journal?.changesForRun(runId).map((change) => change.path) ?? []
      const incomplete = ports.journal?.planRunRevert(runId).expired === true
      return {
        ...result,
        ...(filesChanged.length > 0 ? { filesChanged } : {}),
        ...(incomplete ? { filesChangedIncomplete: true } : {}),
      }
    }
    const runnerDeps = {
      settings: deps.getSettings(),
      skillRegistry: deps.skillRegistry,
      toolRegistry: deps.toolRegistry,
      ports,
      ...(deps.modelFactory ? { modelFactory: deps.modelFactory } : {}),
      queue,
      steering,
      onContext: ({ tokens, cap }: { tokens: number; cap: number }) => {
        deps.store.update(runId, { contextTokens: tokens, contextCap: cap })
      },
      ...(ports.workspace
        ? { projectInstruction: await loadProjectInstruction(ports.workspace) }
        : {}),
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
      ports.terminal?.port.killOwned({ runId }).catch(() => undefined)
      deps.store.detachQueue(runId)
      deps.store.detachSteering(runId)
      controllers.delete(runId)
      parents.delete(runId)
      lastPersist.delete(runId)
    }

    const run = runAgent(
      {
        runId,
        request,
        parent: context,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.seed ? { seed: input.seed } : {}),
      },
      runnerDeps,
      controller.signal,
      onMessages,
    )

    if (background) {
      void run
        .then(withFiles)
        .then(async (result) => {
          deps.store.finish(runId, result)
          const current = deps.store.get(runId) ?? record
          await persist('save', current, context, request.prompt, result.status)
          cleanup()
          const deliver = (): void => deps.onSettle?.(current, result)
          if (!collected.delete(runId)) deliver()
          else if (waiting.has(runId)) gathered.set(runId, deliver)
          markSettled()
        })
        .catch(() => {
          cleanup()
          collected.delete(runId)
          markSettled()
        })
      return { status: 'running', runId, ...(label !== undefined ? { label } : {}) }
    }

    const result = withFiles(await run)
    deps.store.finish(runId, result)
    const current = deps.store.get(runId) ?? record
    await persist('save', current, context, request.prompt, result.status)
    cleanup()
    collected.delete(runId)
    markSettled()
    return { status: 'completed', runId, ...(label !== undefined ? { label } : {}), result }
  }

  const waitRunOf = (run: AgentRunRecord | AgentRunSnapshot): AgentWaitRun => {
    const result = 'result' in run ? run.result : undefined
    const text = result
      ? summarizeAgentResult(result)
      : turnsFromMessages(run.messages)
          .filter((turn) => turn.role === 'assistant')
          .map((turn) => turn.text)
          .pop()
    return {
      runId: run.runId,
      ...(run.label !== undefined ? { label: run.label } : {}),
      status: result?.status ?? run.status,
      ...(text !== undefined ? { result: text } : {}),
      ...(result && 'structured' in result ? { structured: result.structured } : {}),
      ...(result?.structuredError !== undefined ? { structuredError: result.structuredError } : {}),
      ...(result?.filesChanged ? { filesChanged: result.filesChanged } : {}),
      ...(result?.filesChangedIncomplete ? { filesChangedIncomplete: true } : {}),
    }
  }

  return {
    async spawn(context, spawnRequest, options = {}) {
      let profile: AgentProfile | undefined
      if (spawnRequest.agent !== undefined) {
        await deps.profiles?.refresh?.()
        profile = deps.profiles?.get(spawnRequest.agent)
        if (!profile) {
          const ids = (deps.profiles?.list() ?? []).map((entry) => entry.id)
          return {
            status: 'invalid_input',
            message: `No agent profile is named "${spawnRequest.agent}". Available profiles: ${ids.length > 0 ? ids.join(', ') : 'none'}.`,
          }
        }
      }
      const request: AgentRequest = applyAgentProfile(spawnRequest, profile)
      const background = options.background ?? request.background ?? false
      const label = options.label ?? request.label
      const blocked = limitFor(context.parentThreadId)
      if (blocked) return blocked

      const runId = createRunId()
      const record: AgentRunRecord = {
        runId,
        parentThreadId: context.parentThreadId,
        ...(label !== undefined ? { label } : {}),
        ...(profile ? { profile: profile.id } : {}),
        mode: context.mode,
        tier: request.tier,
        status: 'running',
        prompt: request.prompt,
        messages: [promptMessage(runId, request.prompt)],
        text: '',
        toolCalls: 0,
        approvals: [],
        startedAt: Date.now(),
        spec: specOf(request, context),
      }
      return launch({
        context,
        request,
        record,
        background,
        kind: 'create',
        ...(profile ? { profile } : {}),
      })
    },

    async continue(context, runId, text, options = {}) {
      const message = text.trim()
      if (message.length === 0) {
        return { status: 'invalid_input', message: 'A continuation needs a non-empty message.' }
      }
      if (controllers.has(runId) || reserved.has(runId)) {
        return {
          status: 'invalid_input',
          message: `The run ${runId} is still running; steer it instead of continuing it.`,
        }
      }
      const blocked = limitFor(context.parentThreadId)
      if (blocked) return blocked
      reserved.set(runId, context.parentThreadId)
      try {
        const live = deps.store.get(runId)
        const source = live ?? (await loadPersisted(runId))
        if (!source || source.parentThreadId !== context.parentThreadId) {
          return { status: 'invalid_input', message: `No run ${runId} is visible to this conversation.` }
        }
        const spec = source.spec
        if (!spec) {
          return {
            status: 'invalid_input',
            message: 'This run was recorded before runs could be continued, so it cannot be continued.',
          }
        }
        let profile: AgentProfile | undefined
        if (spec.profile !== undefined) {
          await deps.profiles?.refresh?.()
          profile = deps.profiles?.get(spec.profile)
        }
        const ports = await deps.portsFor(context, runId)
        const available = new Set(deps.toolRegistry.availableNames(ports))
        const current = context.toolNames.length > 0 ? new Set(context.toolNames) : null
        const continued: AgentParentContext = {
          ...context,
          toolNames: spec.toolNames.filter(
            (name) => available.has(name) && (current === null || current.has(name)),
          ),
        }
        const request: AgentRequest = {
          prompt: source.prompt,
          mode: spec.mode,
          tier: source.tier,
          ...(spec.skills ? { skills: spec.skills } : {}),
          ...(spec.excludeTools ? { excludeTools: spec.excludeTools } : {}),
          ...(spec.allowTools ? { allowTools: spec.allowTools } : {}),
          ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
          ...(spec.profile !== undefined ? { agent: spec.profile } : {}),
          ...(source.label !== undefined ? { label: source.label } : {}),
        }
        const prior = live ? live.messages : repairLegacyRunMessages(source.messages)
        const seed: RunSeed = { messages: prior, text: message, passOffset: nextPassIndex(runId, prior) }
        const record: AgentRunRecord = {
          runId,
          parentThreadId: source.parentThreadId,
          ...(source.label !== undefined ? { label: source.label } : {}),
          ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
          mode: context.mode,
          tier: source.tier,
          status: 'running',
          prompt: source.prompt,
          messages: openingMessages(runId, source.prompt, seed),
          text: '',
          toolCalls: toolCallCount(prior),
          approvals: [],
          startedAt: source.startedAt,
          spec,
        }
        return launch({
          context: continued,
          request,
          record,
          background: options.background ?? false,
          kind: 'save',
          ports,
          seed,
          ...(profile ? { profile } : {}),
        })
      } finally {
        reserved.delete(runId)
      }
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

    profiles: () => deps.profiles?.list() ?? [],

    async wait(parentThreadId, options, signal) {
      const targets: string[] = []
      const add = (runId: string): void => {
        if (!targets.includes(runId)) targets.push(runId)
      }
      for (const runId of options.runIds ?? []) {
        const identity = await resolveRunIn(parentThreadId, { runId })
        if (!identity) return { ok: false, message: `No run ${runId} is visible to this conversation.` }
        add(identity.runId)
      }
      for (const label of options.labels ?? []) {
        const identity = await resolveRunIn(parentThreadId, { label })
        if (!identity) {
          return {
            ok: false,
            message: `No single run matches the label "${label}"; pass the runId instead.`,
          }
        }
        add(identity.runId)
      }
      if ((options.runIds?.length ?? 0) === 0 && (options.labels?.length ?? 0) === 0) {
        for (const run of deps.store.list(parentThreadId)) {
          if (controllers.has(run.runId)) add(run.runId)
        }
      }

      const pending = targets.filter((runId) => parents.get(runId) === parentThreadId && settlers.has(runId))
      const watched = options.mode === 'any' && pending.length < targets.length ? [] : pending
      for (const runId of watched) {
        collected.add(runId)
        waiting.set(runId, (waiting.get(runId) ?? 0) + 1)
      }
      const waits = watched.map((runId) => settlers.get(runId)!)
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)),
      )
      let timedOut = false
      let aborted = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      if (watched.length > 0) {
        await new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs)
          onAbort = () => {
            aborted = true
            resolve()
          }
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
          void (options.mode === 'any' ? Promise.race(waits) : Promise.all(waits)).then(() => resolve())
        })
      }
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      for (const runId of watched) {
        const count = (waiting.get(runId) ?? 1) - 1
        if (count > 0) waiting.set(runId, count)
        else waiting.delete(runId)
        const deliver = gathered.get(runId)
        gathered.delete(runId)
        if (aborted) {
          collected.delete(runId)
          deliver?.()
        }
      }

      const runs: AgentWaitRun[] = []
      let stillRunning = false
      for (const runId of targets) {
        const live = deps.store.get(runId)
        if (live && controllers.has(runId) && live.status === 'running') {
          collected.delete(runId)
          stillRunning = true
          runs.push(identityOf(live))
          continue
        }
        const settledRun = live ?? (await loadPersisted(runId))
        if (settledRun) runs.push(waitRunOf(settledRun))
      }
      return { ok: true, runs, timedOut: timedOut && stillRunning, aborted }
    },

    resolveRun: resolveRunIn,
  }
}
