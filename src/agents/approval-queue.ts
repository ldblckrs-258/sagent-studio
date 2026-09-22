/**
 * The approval queue for a delegated agent. A background agent that reaches a
 * consent-requiring tool pauses here and surfaces the request to the UI; the
 * queue is settled with `false` whenever the run aborts or the runtime tears
 * down, so no promise is left hanging. Delegated approvals are Allow/Deny only
 * (no persisted "always allow"), so a sub-agent cannot durably weaken the
 * parent's policy.
 */

export interface AgentApprovalRequest {
  runId: string
  toolName: string
  input: unknown
}

export interface PendingAgentApproval {
  id: string
  runId: string
  toolName: string
  input: unknown
  createdAt: number
}

export interface AgentApprovalQueue {
  /** Queues a request and resolves with the user's decision. */
  request(request: AgentApprovalRequest): Promise<boolean>
  pending(): readonly PendingAgentApproval[]
  /** Answers one request; a no-op when the id is unknown or already settled. */
  resolve(id: string, allowed: boolean): void
  /** Answers every pending request at once (used by abort and teardown). */
  settleAll(allowed: boolean): void
  subscribe(listener: () => void): () => void
  getVersion(): number
}

export interface CreateApprovalQueueOptions {
  signal: AbortSignal
  /** Called as each request is queued, so a caller can mirror it into a store. */
  onRequest?(request: PendingAgentApproval): void
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createApprovalQueue(options: CreateApprovalQueueOptions): AgentApprovalQueue {
  const entries = new Map<string, PendingAgentApproval>()
  const resolvers = new Map<string, (allowed: boolean) => void>()
  const listeners = new Set<() => void>()
  let version = 0
  let closed = options.signal.aborted

  const notify = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  const settle = (id: string, allowed: boolean): void => {
    const resolver = resolvers.get(id)
    if (!resolver) return
    resolvers.delete(id)
    entries.delete(id)
    resolver(allowed)
    notify()
  }

  const settleAll = (allowed: boolean): void => {
    for (const id of [...resolvers.keys()]) settle(id, allowed)
  }

  options.signal.addEventListener(
    'abort',
    () => {
      closed = true
      settleAll(false)
    },
    { once: true },
  )

  return {
    request({ runId, toolName, input }) {
      if (closed || options.signal.aborted) return Promise.resolve(false)
      const id = createId()
      const entry: PendingAgentApproval = {
        id,
        runId,
        toolName,
        input,
        createdAt: Date.now(),
      }
      entries.set(id, entry)
      const decision = new Promise<boolean>((resolve) => {
        resolvers.set(id, resolve)
      })
      options.onRequest?.(entry)
      notify()
      return decision
    },
    pending: () => [...entries.values()],
    resolve(id, allowed) {
      settle(id, allowed)
    },
    settleAll(allowed) {
      settleAll(allowed)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
  }
}
