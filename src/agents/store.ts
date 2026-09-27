import type { UIMessage } from 'ai'
import type { AgentRunStatus, AgentStopReason, ChatMode } from '../chat/types'
import type { ModelTier } from '../vault/settings'
import { useVaultStore } from '../vault/store'
import type { AgentApprovalQueue, PendingAgentApproval } from './approval-queue'
import { toolCallCount } from './run-transcript'
import type { AgentRunResult, AgentRunSpec, AgentSteeringControl } from './types'

export interface AgentRunRecord {
  runId: string
  parentThreadId: string
  label?: string
  profile?: string
  mode: ChatMode
  tier: ModelTier
  status: AgentRunStatus
  prompt: string
  messages: UIMessage[]
  text: string
  toolCalls: number
  approvals: PendingAgentApproval[]
  startedAt: number
  endedAt?: number
  result?: AgentRunResult
  stopReason?: AgentStopReason
  contextTokens?: number
  contextCap?: number
  spec?: AgentRunSpec
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
  private readonly steering = new Map<string, AgentSteeringControl>()
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

  setMessages(runId: string, messages: UIMessage[]): void {
    const current = this.runs.get(runId)
    if (!current) return
    this.runs.set(runId, { ...current, messages, toolCalls: toolCallCount(messages) })
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
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    })
  }

  remove(runId: string): void {
    this.steering.delete(runId)
    if (this.runs.delete(runId)) this.notify()
  }

  attachQueue(runId: string, queue: AgentApprovalQueue): void {
    this.queues.set(runId, queue)
  }

  detachQueue(runId: string): void {
    this.queues.delete(runId)
    this.update(runId, { approvals: [] })
  }

  attachSteering(runId: string, handle: AgentSteeringControl): void {
    this.steering.set(runId, handle)
  }

  detachSteering(runId: string): void {
    this.steering.delete(runId)
  }

  /**
   * Enqueues a steering turn for a live run. The runner adds it to the run's
   * transcript when it drains the queue at the next step boundary, so the run
   * shows the turn at the point it was actually injected. A run that has
   * already stopped draining (a settled step cap, an abort) refuses the steer so
   * the caller does not keep an optimistic echo that can never be delivered.
   */
  steer(runId: string, text: string): boolean {
    const handle = this.steering.get(runId)
    if (!handle || this.runs.get(runId)?.status !== 'running') return false
    if (handle.accepting && !handle.accepting()) return false
    handle.enqueue(text)
    return true
  }

  /** Records a stop reason on the live run and lets the handle abort it. */
  requestStop(runId: string, reason: AgentStopReason): boolean {
    const handle = this.steering.get(runId)
    if (!handle) return false
    handle.requestStop(reason)
    this.notify()
    return true
  }

  stopRequested(runId: string): boolean {
    return this.steering.get(runId)?.stopRequested() ?? false
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
    this.steering.clear()
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
