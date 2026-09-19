import type { UIMessage } from 'ai'
import type { ChatThread } from './types'

export type ChatMessageMetadata = {
  chatStatus?: 'streaming' | 'done'
}

type MessagePart = UIMessage['parts'][number]

const TERMINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied'])

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

function sanitizePart(part: MessagePart): MessagePart {
  if (!isToolPart(part) || isTerminal(part)) return part
  const rest = { ...(part as Record<string, unknown>) }
  delete rest.output
  return {
    ...rest,
    state: 'output-error',
    errorText: 'The run was interrupted before this tool call completed.',
  } as unknown as MessagePart
}

export function setChatStatus(message: UIMessage, status: 'streaming' | 'done'): UIMessage {
  const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
  return { ...message, metadata: { ...metadata, chatStatus: status } }
}

export function sanitizePartial(message: UIMessage): UIMessage {
  return setChatStatus({ ...message, parts: message.parts.map(sanitizePart) }, 'done')
}

export function rehydrateThread(thread: ChatThread): ChatThread {
  const messages = thread.messages.map((message) => {
    const status = (message.metadata as ChatMessageMetadata | undefined)?.chatStatus
    const hasNonTerminalTool = message.parts.some(
      (part) => isToolPart(part) && !isTerminal(part),
    )
    if (status === 'streaming' || hasNonTerminalTool) return sanitizePartial(message)
    return message
  })
  return { ...thread, messages }
}
