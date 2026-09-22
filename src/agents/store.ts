import type { AgentRunStatus, ChatMode } from '../chat/types'
import type { ModelTier } from '../vault/settings'
import { useVaultStore } from '../vault/store'
import type { AgentApprovalQueue, PendingAgentApproval } from './approval-queue'
import type { AgentRunEvent, AgentRunResult } from './types'

export interface AgentRunRecord {
  runId: string
  parentThreadId: string
  label?: string
  mode: ChatMode
  tier: ModelTier
  status: AgentRunStatus
  prompt: string
  events: AgentRunEvent[]
  /** Accumulated assistant text; the event log is the source of the transcript. */
  text: string
  toolCalls: number
  approvals: PendingAgentApproval[]
  startedAt: number
  endedAt?: number
  result?: AgentRunResult
}

/**
 * The observable registry of live agent runs. It follows the `ToolRegistry`
 * subscribe/version idiom so the Agents panel re-renders through
 * `useRegistryVersion` rather than a bespoke hook, and it clears with the chat
 * store on a vault lock so no zombie run survives.
 */
export class AgentRunStore {
  private readonly runs = new Map<string, AgentRunRecord>()
  private readonly queues = new Map<string, AgentApprovalQueue>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion(): number {
    return this.version
  }

  private notify(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  register(record: AgentRunRecord): void {
    this.runs.set(record.runId, record)
    this.notify()
  }

  get(runId: string): AgentRunRecord | undefined {
    return this.runs.get(runId)
  }

  list(parentThreadId?: string): AgentRunRecord[] {
    const all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
    return parentThreadId === undefined
      ? all
      : all.filter((run) => run.parentThreadId === parentThreadId)
  }

  update(runId: string, patch: Partial<AgentRunRecord>): void {
    const current = this.runs.get(runId)
    if (!current) return
    this.runs.set(runId, { ...current, ...patch })
    this.notify()
  }

  appendEvent(runId: string, event: AgentRunEvent): void {
    const current = this.runs.get(runId)
    if (!current) return
    const next: AgentRunRecord = { ...current, events: [...current.events, event] }
    if (event.type === 'text-delta') next.text = current.text + event.text
    if (event.type === 'tool-call') next.toolCalls = current.toolCalls + 1
    this.runs.set(runId, next)
    this.notify()
  }

  setStatus(runId: string, status: AgentRunStatus): void {
    this.update(runId, { status })
  }

  finish(runId: string, result: AgentRunResult): void {
    this.update(runId, {
      status: result.status,
      endedAt: Date.now(),
      result,
      text: result.text,
      toolCalls: result.toolCalls,
    })
  }

  remove(runId: string): void {
    if (this.runs.delete(runId)) this.notify()
  }

  attachQueue(runId: string, queue: AgentApprovalQueue): void {
    this.queues.set(runId, queue)
  }

  detachQueue(runId: string): void {
    this.queues.delete(runId)
    this.update(runId, { approvals: [] })
  }

  addApproval(runId: string, approval: PendingAgentApproval): void {
    const current = this.runs.get(runId)
    if (!current) return
    this.update(runId, { approvals: [...current.approvals, approval] })
  }

  /** Answers a queued approval in whichever live queue owns its id. */
  resolveApproval(approvalId: string, allowed: boolean): void {
    for (const queue of this.queues.values()) queue.resolve(approvalId, allowed)
    for (const [runId, run] of this.runs) {
      const approvals = run.approvals.filter((entry) => entry.id !== approvalId)
      if (approvals.length !== run.approvals.length) this.update(runId, { approvals })
    }
  }

  pendingApprovals(parentThreadId?: string): PendingAgentApproval[] {
    return this.list(parentThreadId).flatMap((run) => run.approvals)
  }

  pendingApprovalCount(parentThreadId?: string): number {
    return this.pendingApprovals(parentThreadId).length
  }

  clear(): void {
    this.runs.clear()
    this.queues.clear()
    this.notify()
  }
}

export const agentRunStore = new AgentRunStore()

// A vault lock tears the session down; a live run record would be a phantom.
useVaultStore.subscribe((state, previous) => {
  if (previous.status === 'unlocked' && state.status !== 'unlocked') {
    agentRunStore.clear()
  }
})
