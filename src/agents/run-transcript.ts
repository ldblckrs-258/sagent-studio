import { isToolUIPart } from 'ai'
import type { UIMessage } from 'ai'

type Part = UIMessage['parts'][number]

export interface RunSteer {
  step: number
  text: string
}

export interface RunPass {
  assistant: UIMessage | null
  steers: RunSteer[]
  after: string[]
}

const LOST_RESULT = 'The result of this call was not recorded.'

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function stepOffset(parts: readonly Part[], step: number): number {
  let seen = 0
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].type !== 'step-start') continue
    if (seen === step) return index
    seen += 1
  }
  return parts.length
}

function hasContent(parts: readonly Part[]): boolean {
  return parts.some((part) => part.type !== 'step-start')
}

export function promptMessage(runId: string, prompt: string): UIMessage {
  return userMessage(`${runId}-prompt`, prompt)
}

export function passMessages(runId: string, passIndex: number, pass: RunPass): UIMessage[] {
  const messages: UIMessage[] = []
  const parts = pass.assistant?.parts ?? []
  const metadata = pass.assistant?.metadata
  let start = 0
  let segment = 0
  const pushAssistant = (slice: Part[]): void => {
    if (!hasContent(slice)) return
    messages.push({
      id: `${runId}-a${passIndex}-${segment}`,
      role: 'assistant',
      parts: slice,
      ...(metadata !== undefined ? { metadata } : {}),
    })
    segment += 1
  }
  pass.steers.forEach((steer, steerIndex) => {
    const at = Math.max(start, stepOffset(parts, steer.step))
    pushAssistant(parts.slice(start, at))
    messages.push(userMessage(`${runId}-s${passIndex}-${steerIndex}`, steer.text))
    start = at
  })
  pushAssistant(parts.slice(start))
  pass.after.forEach((text, afterIndex) => {
    messages.push(userMessage(`${runId}-u${passIndex}-${afterIndex}`, text))
  })
  return messages
}

export function buildRunMessages(
  runId: string,
  prompt: string,
  passes: readonly RunPass[],
): UIMessage[] {
  return [
    promptMessage(runId, prompt),
    ...passes.flatMap((pass, passIndex) => passMessages(runId, passIndex, pass)),
  ]
}

export function toolCallCount(messages: readonly UIMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (isToolUIPart(part)) count += 1
    }
  }
  return count
}

function isToolPart(part: Part): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

function repairParts(parts: readonly Part[]): Part[] {
  const next: Part[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      const last = next[next.length - 1]
      if (last !== undefined && last.type === 'text') {
        next[next.length - 1] = { type: 'text', text: last.text + part.text }
      } else {
        next.push(part)
      }
      continue
    }
    const record = part as Record<string, unknown>
    if (
      isToolPart(part) &&
      record.state === 'output-available' &&
      (record.output === undefined || isEmptyObject(record.output))
    ) {
      const rest = { ...record }
      delete rest.output
      next.push({ ...rest, state: 'output-error', errorText: LOST_RESULT } as unknown as Part)
      continue
    }
    next.push(part)
  }
  return next
}

export function repairLegacyRunMessages(messages: readonly UIMessage[]): UIMessage[] {
  return messages.map((message) => ({ ...message, parts: repairParts(message.parts) }))
}
