import type { ThreadMessageLike } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import type { ChatMessageMetadata } from './sanitize'

/**
 * A structural view of an assistant-ui content part. The runtime hands these
 * back to `onNew`/`onEdit`, and pinning an exported part type from the library
 * here would couple this pure module to an unstable internal name.
 */
export type IncomingPart = {
  type: string
  text?: unknown
  [key: string]: unknown
}

export type IncomingContent = readonly IncomingPart[]

type ThreadContent = Exclude<ThreadMessageLike['content'], string>
type ThreadPart = ThreadContent[number]
type UiPart = UIMessage['parts'][number]
type ToolPartLike = Extract<ThreadPart, { type: 'tool-call' }>
type ToolPartArgs = NonNullable<ToolPartLike['args']>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function textOf(part: IncomingPart): string {
  return typeof part.text === 'string' ? part.text : ''
}

function isFailureEnvelope(output: unknown): boolean {
  return isPlainObject(output) && (output as { ok?: unknown }).ok === false
}

const APPROVAL_OPTIONS = [
  { id: 'allow-once', kind: 'allow-once' },
  { id: 'allow-always', kind: 'allow-always' },
] as const

function approvalOf(part: Record<string, unknown>): Record<string, unknown> | undefined {
  return isPlainObject(part.approval) ? part.approval : undefined
}

function convertToolPart(part: Record<string, unknown>, toolName: string): ThreadPart {
  const input = part.input
  const base = {
    type: 'tool-call' as const,
    ...(typeof part.toolCallId === 'string' ? { toolCallId: part.toolCallId } : {}),
    toolName,
    ...(isPlainObject(input) ? { args: input as ToolPartArgs } : {}),
    argsText: JSON.stringify(input ?? {}),
  }
  switch (part.state) {
    case 'output-available':
      return { ...base, result: part.output, isError: isFailureEnvelope(part.output) }
    case 'output-error':
      return {
        ...base,
        result: typeof part.errorText === 'string' ? part.errorText : 'The tool call failed.',
        isError: true,
      }
    case 'output-denied': {
      const approval = approvalOf(part)
      const reason = approval && typeof approval.reason === 'string' ? approval.reason : undefined
      return {
        ...base,
        ...(approval ? { approval } : {}),
        result: reason ?? 'The tool call was denied.',
        isError: true,
      } as ThreadPart
    }
    case 'approval-requested': {
      const approval = approvalOf(part)
      return {
        ...base,
        ...(approval ? { approval: { ...approval, options: [...APPROVAL_OPTIONS] } } : {}),
      } as ThreadPart
    }
    case 'approval-responded': {
      const approval = approvalOf(part)
      return { ...base, ...(approval ? { approval } : {}) } as ThreadPart
    }
    default:
      return base
  }
}

function convertPart(part: UiPart): ThreadPart | null {
  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0 ? { type: 'text', text: part.text } : null
    case 'reasoning':
      return part.text.trim().length > 0 ? { type: 'reasoning', text: part.text } : null
    case 'step-start':
      return null
    case 'file':
      return {
        type: 'file',
        data: part.url,
        mimeType: part.mediaType,
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
      }
    case 'source-url':
      return {
        type: 'source',
        sourceType: 'url',
        id: part.sourceId,
        url: part.url,
        ...(part.title !== undefined ? { title: part.title } : {}),
      }
    case 'source-document':
      return {
        type: 'source',
        sourceType: 'document',
        id: part.sourceId,
        title: part.title,
        mediaType: part.mediaType,
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
      }
    default:
      if (part.type === 'dynamic-tool') {
        return convertToolPart(part as unknown as Record<string, unknown>, part.toolName)
      }
      if (part.type.startsWith('tool-')) {
        return convertToolPart(
          part as unknown as Record<string, unknown>,
          part.type.slice('tool-'.length),
        )
      }
      if (part.type.startsWith('data-')) {
        return { type: part.type, data: (part as { data?: unknown }).data } as ThreadPart
      }
      return null
  }
}

function terminalError(message: UIMessage): string | undefined {
  if (message.role !== 'assistant') return undefined
  const metadata = message.metadata as { error?: unknown; chatStatus?: unknown } | undefined
  if (typeof metadata?.error === 'string' && metadata.error.length > 0) return metadata.error
  if (metadata?.chatStatus === 'error') return 'The run failed.'
  return undefined
}

/**
 * Maps an engine-owned `UIMessage` onto the runtime's `ThreadMessageLike`.
 * Message `status` is emitted only to force a terminal error, and never on a
 * non-assistant message: the runtime computes every other status itself.
 */
export function toThreadMessageLike(message: UIMessage, index: number): ThreadMessageLike {
  const content: ThreadPart[] = []
  for (const part of message.parts) {
    const converted = convertPart(part)
    if (converted) content.push(converted)
  }
  // `fromThreadMessageLike` rejects reasoning/source/tool-call parts on a user
  // message, so a stray part cannot reach the runtime and crash the render.
  const safeContent =
    message.role === 'user'
      ? content.filter((part) => part.type !== 'reasoning' && part.type !== 'source' && part.type !== 'tool-call')
      : content

  const metadata = message.metadata as ChatMessageMetadata | undefined
  const directive = metadata?.skillDirective
  const compaction = metadata?.compaction
  // The directive and the boundary both cross over because the renderer needs
  // them to draw a marker instead of an ordinary bubble — a boundary rendered
  // as a bubble offers Regenerate, which would drop it and silently
  // un-compact the thread. Usage stays on our side, where the meter reads it
  // straight from the store.
  const custom = {
    ...(directive ? { skillDirective: directive } : {}),
    ...(compaction ? { compaction } : {}),
  }

  const like: ThreadMessageLike = {
    id: message.id || `message-${index}`,
    role: message.role,
    content: safeContent,
    ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
  }

  const error = terminalError(message)
  if (error !== undefined) {
    return { ...like, status: { type: 'incomplete', reason: 'error', error } }
  }
  return like
}

/** Reverse converter for `onEdit`: assistant-ui content back to engine parts. */
export function toUiParts(content: IncomingContent): UIMessage['parts'] {
  const parts: UiPart[] = []
  for (const part of content) {
    switch (part.type) {
      case 'text':
        parts.push({ type: 'text', text: textOf(part) })
        break
      case 'reasoning':
        parts.push({ type: 'reasoning', text: textOf(part) })
        break
      case 'tool-call': {
        const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown'
        const hasResult = part.result !== undefined || part.isError === true
        const approval = isPlainObject(part.approval)
          ? (part.approval as Record<string, unknown>)
          : undefined
        const pausedState =
          approval && !hasResult
            ? typeof approval.approved === 'boolean'
              ? 'approval-responded'
              : 'approval-requested'
            : undefined
        const state =
          pausedState ??
          (hasResult ? (part.isError ? 'output-error' : 'output-available') : 'input-available')
        const toolPart = {
          type: `tool-${toolName}`,
          ...(typeof part.toolCallId === 'string' ? { toolCallId: part.toolCallId } : {}),
          state,
          input: part.args ?? {},
          ...(hasResult ? { output: part.result } : {}),
          ...(part.isError && typeof part.result === 'string' ? { errorText: part.result } : {}),
          ...(approval ? { approval } : {}),
        }
        parts.push(toolPart as unknown as UiPart)
        break
      }
      case 'source': {
        if (part.sourceType === 'url') {
          parts.push({
            type: 'source-url',
            sourceId: String(part.id ?? ''),
            url: String(part.url ?? ''),
            ...(typeof part.title === 'string' ? { title: part.title } : {}),
          } as UiPart)
        } else {
          parts.push({
            type: 'source-document',
            sourceId: String(part.id ?? ''),
            mediaType: String(part.mediaType ?? ''),
            title: String(part.title ?? ''),
          } as UiPart)
        }
        break
      }
      case 'file':
        parts.push({
          type: 'file',
          url: String(part.data ?? ''),
          mediaType: String(part.mimeType ?? ''),
          ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
        } as UiPart)
        break
      default:
        if (part.type.startsWith('data-')) {
          parts.push({ type: part.type, data: part.data } as unknown as UiPart)
        }
        break
    }
  }
  return parts
}

/** Joins non-empty `text` parts; ignores reasoning, tool, and other parts. */
export function extractText(content: IncomingContent): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => textOf(part))
    .filter((text) => text.length > 0)
    .join('\n')
}
