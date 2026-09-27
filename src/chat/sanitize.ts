import type { UIMessage } from 'ai'
import type { AttachmentRecord } from './attachments'
import type { CompactionMeta } from './boundary'
import type { SkillDirective } from './skill-invoke'
import type { AgentNoticeMeta, ChatThread } from './types'
import type { TurnUsage } from './usage'

export type ChatMessageMetadata = {
  chatStatus?: 'streaming' | 'done'
  /** Token accounting for the turn this message completed. */
  usage?: TurnUsage
  /** Present only on a compaction boundary, whose text is the summary. */
  compaction?: CompactionMeta
  /** Present only on a `/<skill-id>` directive, which renders as a marker. */
  skillDirective?: SkillDirective
  /** What this user turn attached, so a later turn can skip re-inlining it. */
  attachments?: AttachmentRecord[]
  /** The structured report on a background sub-agent's notice message. */
  agentReport?: AgentNoticeMeta
  autoContinue?: { runId?: string; label?: string }
  rewind?: { seq: number; workspace?: string }
}

type MessagePart = UIMessage['parts'][number]

const TERMINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied'])

/** A part waiting on a user approval decision. */
export const PAUSED_TOOL_STATES = new Set(['approval-requested', 'approval-responded'])

const EXPIRED_ERROR = 'The approval request expired when the session ended.'
const INTERRUPTED_ERROR = 'The run was interrupted before this tool call completed.'

function partType(part: MessagePart): string {
  return typeof (part as { type?: unknown }).type === 'string'
    ? (part as { type: string }).type
    : ''
}

function isToolPart(part: MessagePart): boolean {
  const type = partType(part)
  return type === 'dynamic-tool' || type.startsWith('tool-')
}

function isTerminal(part: MessagePart): boolean {
  const state = (part as { state?: unknown }).state
  return typeof state === 'string' && TERMINAL_TOOL_STATES.has(state)
}

function isPaused(part: MessagePart): boolean {
  const state = (part as { state?: unknown }).state
  return typeof state === 'string' && PAUSED_TOOL_STATES.has(state)
}

function sanitizePart(part: MessagePart, expireApprovals: boolean): MessagePart {
  if (!isToolPart(part) || isTerminal(part)) return part
  const paused = isPaused(part)
  if (paused && !expireApprovals) return part
  const rest = { ...(part as Record<string, unknown>) }
  delete rest.output
  const approval = (part as { approval?: Record<string, unknown> }).approval
  return {
    ...rest,
    state: 'output-error',
    errorText: paused ? EXPIRED_ERROR : INTERRUPTED_ERROR,
    ...(paused && approval !== undefined
      ? { approval: { ...approval, resolution: 'expired' } }
      : {}),
  } as unknown as MessagePart
}

export function setChatStatus(message: UIMessage, status: 'streaming' | 'done'): UIMessage {
  const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
  return { ...message, metadata: { ...metadata, chatStatus: status } }
}

/** Expires any paused approval part in place, without touching status. */
export function expireApprovals(message: UIMessage): UIMessage {
  return { ...message, parts: message.parts.map((part) => sanitizePart(part, true)) }
}

export function sanitizePartial(
  message: UIMessage,
  options: { expireApprovals?: boolean } = {},
): UIMessage {
  return setChatStatus(
    {
      ...message,
      parts: message.parts.map((part) => sanitizePart(part, options.expireApprovals === true)),
    },
    'done',
  )
}

/**
 * Rewrites a `running` background delegation result to `interrupted`. A reload
 * cannot resume a detached run, so leaving it `running` would show a phantom
 * forever; the matching child thread is reconciled the same way.
 */
function reconcileAgentResultPart(part: MessagePart): MessagePart {
  const type = partType(part)
  if (type !== 'dynamic-tool' && type !== 'tool-spawn_agent') return part
  const record = part as Record<string, unknown>
  if (type === 'dynamic-tool' && record.toolName !== 'spawn_agent') return part
  const output = record.output as { ok?: unknown; value?: { status?: unknown } } | undefined
  const value = output?.value
  if (output?.ok !== true || value === undefined || value.status !== 'running') return part
  return {
    ...record,
    output: { ...output, value: { ...value, status: 'interrupted' } },
  } as unknown as MessagePart
}

export function rehydrateThread(thread: ChatThread): ChatThread {
  const messages = thread.messages.map((message) => {
    const status = (message.metadata as ChatMessageMetadata | undefined)?.chatStatus
    const hasNonTerminalTool = message.parts.some(
      (part) => isToolPart(part) && !isTerminal(part),
    )
    // A reload cannot resume a stream, so a persisted paused approval is expired
    // rather than left to poison the next request.
    const reconciled = message.parts.map((part) => reconcileAgentResultPart(part))
    if (status === 'streaming' || hasNonTerminalTool) {
      return sanitizePartial({ ...message, parts: reconciled }, { expireApprovals: true })
    }
    return { ...message, parts: reconciled }
  })
  const agent =
    thread.agent?.status === 'running'
      ? { ...thread.agent, status: 'interrupted' as const }
      : thread.agent
  return { ...thread, messages, ...(agent ? { agent } : {}) }
}
