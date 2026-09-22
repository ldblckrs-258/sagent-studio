import type { LanguageModelUsage } from 'ai'
import type { AgentRunStatus, ChatMode } from '../chat/types'
import type { ModelTier } from '../vault/settings'

export type { AgentRunStatus }

/**
 * Tools a delegated agent may never use: `spawn_agent` keeps delegation one
 * level deep, `change_mode` would mutate the parent conversation's mode,
 * `update_plan` would clobber the parent plan, and `restore` reverts the
 * parent's shared journal.
 */
export const BLOCKED_AGENT_TOOLS: readonly string[] = [
  'spawn_agent',
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
}

export type AgentRunEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; input: unknown }
  | { type: 'tool-result'; toolName: string; toolCallId: string }
  | { type: 'tool-error'; toolName: string; toolCallId: string; error: string }
  | { type: 'approval-requested'; approvalId: string; toolName: string; input: unknown }

export interface AgentSpawnOptions {
  background?: boolean
  label?: string
}

export type AgentSpawnOutcome =
  | { status: 'completed'; label?: string; result: AgentRunResult }
  | { status: 'running'; runId: string; label?: string }
  | { status: 'limit_exceeded'; message: string }
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
