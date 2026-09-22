import type { UIMessage } from 'ai'
import type { AttachmentRecord } from './attachments'
import type { CompactionMeta } from './boundary'
import type { SkillDirective } from './skill-invoke'
import type { ChatThread } from './types'
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

export function rehydrateThread(thread: ChatThread): ChatThread {
  const messages = thread.messages.map((message) => {
    const status = (message.metadata as ChatMessageMetadata | undefined)?.chatStatus
    const hasNonTerminalTool = message.parts.some(
      (part) => isToolPart(part) && !isTerminal(part),
    )
    // A reload cannot resume a stream, so a persisted paused approval is expired
    // rather than left to poison the next request.
    if (status === 'streaming' || hasNonTerminalTool) {
      return sanitizePartial(message, { expireApprovals: true })
    }
    return message
  })
  return { ...thread, messages }
}
