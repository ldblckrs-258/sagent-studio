import type { UIMessage } from 'ai'
import type { AgentRunEvent } from './types'

type Part = UIMessage['parts'][number]

function toolPart(event: { toolName: string; toolCallId: string; input?: unknown }): Part {
  return {
    type: 'dynamic-tool',
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    state: 'input-available',
    input: event.input ?? {},
  } as unknown as Part
}

function appendText(parts: UIMessage['parts'], text: string): void {
  const last = parts[parts.length - 1]
  if (last !== undefined && last.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text }
    return
  }
  parts.push({ type: 'text', text })
}

/**
 * Projects a live run's event log into the same `UIMessage` shape the main
 * thread renders, so the Agents panel can mount it in an assistant-ui runtime
 * and reuse the real message components.
 *
 * Consecutive text deltas coalesce into one text part (assistant-ui renders
 * each part separately), and a tool call is only marked complete once its
 * result arrives: an open call reads as running, never as an approval prompt.
 * `isFinal` closes any tool call the log never resolved, for a settled run.
 */
export function uiMessagesFromEvents(
  runId: string,
  prompt: string,
  events: readonly AgentRunEvent[],
  isFinal = false,
): UIMessage[] {
  const messages: UIMessage[] = [
    { id: `${runId}-prompt`, role: 'user', parts: [{ type: 'text', text: prompt }] },
  ]
  let parts: UIMessage['parts'] = []
  let index = 0
  const flush = (): void => {
    if (parts.length > 0) {
      messages.push({
        id: `${runId}-assistant-${index}`,
        role: 'assistant',
        parts,
        metadata: { chatStatus: 'done' },
      })
    }
    parts = []
    index += 1
  }
  const toolSlot = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'text-delta') {
      appendText(parts, event.text)
    } else if (event.type === 'tool-call') {
      toolSlot.set(event.toolCallId, parts.length)
      parts.push(toolPart(event))
    } else if (event.type === 'tool-result') {
      const slot = toolSlot.get(event.toolCallId)
      if (slot !== undefined) {
        parts[slot] = {
          ...(parts[slot] as Record<string, unknown>),
          state: 'output-available',
          output: event.output ?? {},
        } as unknown as Part
      }
    } else if (event.type === 'tool-error') {
      const slot = toolSlot.get(event.toolCallId)
      if (slot !== undefined) {
        parts[slot] = {
          ...(parts[slot] as Record<string, unknown>),
          state: 'output-error',
          errorText: event.error,
        } as unknown as Part
      }
    } else if (event.type === 'user-message') {
      flush()
      messages.push({
        id: `${runId}-steer-${index}`,
        role: 'user',
        parts: [{ type: 'text', text: event.text }],
      })
    }
  }
  if (isFinal) {
    parts = parts.map((part) => {
      const record = part as Record<string, unknown>
      if (part.type === 'dynamic-tool' && record.state === 'input-available') {
        return { ...record, state: 'output-available', output: {} } as unknown as Part
      }
      return part
    })
  }
  flush()
  return messages
}

function normalizeParts(parts: UIMessage['parts'], isFinal: boolean): UIMessage['parts'] {
  const next: UIMessage['parts'] = []
  for (const part of parts) {
    if (part.type === 'text') {
      appendText(next, part.text)
      continue
    }
    const record = part as Record<string, unknown>
    const isTool = part.type === 'dynamic-tool' || part.type.startsWith('tool-')
    if (isTool && record.state === 'output-available' && record.output === undefined) {
      next.push({ ...record, output: {} } as unknown as Part)
      continue
    }
    if (isTool && isFinal && record.state === 'input-available') {
      next.push({ ...record, state: 'output-available', output: {} } as unknown as Part)
      continue
    }
    next.push(part)
  }
  return next
}

/**
 * Normalizes a persisted child thread for the panel. A transcript written before
 * text deltas were coalesced (one part per chunk) would render one word per
 * line, and a tool part left without a result would read as a pending approval.
 */
export function normalizeThreadMessages(
  messages: readonly UIMessage[],
  isFinal = true,
): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: normalizeParts(message.parts, isFinal),
  }))
}
