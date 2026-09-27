import type { LanguageModelUsage } from 'ai'
import type { AgentRunSpec, AgentRunStatus, AgentStopReason, ChatMode } from '../chat/types'
import type { ModelTier } from '../vault/settings'

export type { AgentRunSpec, AgentRunStatus, AgentStopReason }

/**
 * Tools a delegated agent may never use: `spawn_agent`, `stop_agent`, and
 * `read_agent` keep delegation one level deep and stop a child from controlling
 * its siblings, `change_mode` would mutate the parent conversation's mode,
 * `update_plan` would clobber the parent plan, and `restore` reverts the
 * parent's shared journal.
 */
export const BLOCKED_AGENT_TOOLS: readonly string[] = [
  'spawn_agent',
  'stop_agent',
  'read_agent',
  'message_agent',
  'wait_agents',
  'change_mode',
  'update_plan',
  'restore',
]

export interface AgentRequest {
  prompt: string
  /** Requested mode; clamped to the parent's mode before use. */
  mode: ChatMode
  tier: ModelTier
  /** Skill ids to activate for the delegated run. */
  skills?: readonly string[]
  /** Tool names removed from the delegated toolset. */
  excludeTools?: readonly string[]
  background?: boolean
  label?: string
  outputSchema?: Record<string, unknown>
  agent?: string
  allowTools?: readonly string[]
}

export type AgentSpawnRequest = Omit<AgentRequest, 'mode' | 'tier'> & {
  mode?: ChatMode
  tier?: ModelTier
}

export interface AgentParentContext {
  parentThreadId: string
  /** The parent run's mode; the ceiling for the delegated run. */
  mode: ChatMode
  /** The parent's final tool names; the pool a delegated agent may draw from. */
  toolNames: string[]
  providerId: string
  modelId?: string
  /** The parent's own system instruction, when it has one. */
  systemInstruction?: string
}

export interface AgentRunResult {
  status: AgentRunStatus
  mode: ChatMode
  tier: ModelTier
  text: string
  toolCalls: number
  usage?: LanguageModelUsage
  error?: string
  truncated?: boolean
  stopReason?: AgentStopReason
  structured?: unknown
  structuredError?: string
  filesChanged?: string[]
  filesChangedIncomplete?: boolean
}

/** The read side of a run's steering channel, consumed by the runner. */
export interface AgentSteeringHandle {
  drain(): string[]
  stopRequested(): boolean
  stopReason(): AgentStopReason | undefined
  /**
   * Whether the channel can still take a steer. False once the runner has left
   * the point where it drains, so an accepted-but-undelivered steer is refused
   * instead of echoed optimistically forever. Absent reads as accepting.
   */
  accepting?(): boolean
  /** Marks the channel closed; the runner calls this once it will no longer drain. */
  close?(): void
}

/**
 * The write side of a run's steering channel. The owning runtime enqueues a
 * steering turn and records a stop; the implementation aborts the run's
 * controller when a stop is requested.
 */
export interface AgentSteeringControl extends AgentSteeringHandle {
  enqueue(text: string): void
  requestStop(reason: AgentStopReason): void
}

/** Identifies a delegated run by exact id or by a user-facing label. */
export interface AgentRunIdentifier {
  runId?: string
  label?: string
}

/** A run's stable identity, returned by `resolveRun` once a match is unique. */
export interface AgentRunIdentity {
  runId: string
  label?: string
  status: AgentRunStatus
}

/** One projected turn of a delegated run's transcript. */
export interface AgentTurn {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
}

/**
 * Reads a run's transcript. `lastN` selects the most recent turns (clamped to
 * 1..50, default 6); `includeTools` keeps or drops tool turns. Turns are
 * returned oldest-first, so the array reads in conversation order.
 */
export interface AgentReadOptions {
  lastN?: number
  includeTools?: boolean
}

/** A bounded, readable projection of a delegated run. */
export interface AgentTranscript {
  runId: string
  label?: string
  status: AgentRunStatus
  stopReason?: AgentStopReason
  turns: AgentTurn[]
}

export interface AgentSpawnOptions {
  background?: boolean
  label?: string
}

export interface AgentContinueOptions {
  background?: boolean
}

export const DEFAULT_WAIT_TIMEOUT_MS = 300_000
export const MAX_WAIT_TIMEOUT_MS = 1_800_000

export interface AgentWaitOptions {
  runIds?: readonly string[]
  labels?: readonly string[]
  mode?: 'all' | 'any'
  timeoutMs?: number
}

export interface AgentWaitRun {
  runId: string
  label?: string
  status: AgentRunStatus
  result?: string
  structured?: unknown
  structuredError?: string
  filesChanged?: string[]
  filesChangedIncomplete?: boolean
}

export type AgentWaitOutcome =
  | { ok: true; runs: AgentWaitRun[]; timedOut: boolean; aborted: boolean }
  | { ok: false; message: string }

export type AgentSpawnOutcome =
  | { status: 'completed'; runId: string; label?: string; result: AgentRunResult }
  | { status: 'running'; runId: string; label?: string }
  | { status: 'limit_exceeded'; message: string }
  | { status: 'invalid_input'; message: string }
  | { status: 'error'; message: string }

/** A short, bounded summary of a run, for a tool result or a background notice. */
export function summarizeAgentResult(result: AgentRunResult): string {
  if (result.status === 'completed') {
    const text = result.text.trim()
    return text.length > 0 ? text : 'The agent completed without producing text.'
  }
  if (result.error) return `The agent ${result.status}: ${result.error}`
  return `The agent ${result.status}.`
}
