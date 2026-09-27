import { isToolUIPart } from 'ai'
import type { UIMessage } from 'ai'

type Part = UIMessage['parts'][number]

export interface RunSteer {
  step: number
  text: string
}

export interface RunCompaction {
  step: number
  at: number
  tokensBefore: number
  replacedCount: number
  summary?: string
  error?: string
}

export interface RunPass {
  assistant: UIMessage | null
  steers: RunSteer[]
  after: string[]
  compactions?: RunCompaction[]
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

export function continuationMessage(runId: string, passIndex: number, text: string): UIMessage {
  return userMessage(`${runId}-c${passIndex}`, text)
}

export function nextPassIndex(runId: string, messages: readonly UIMessage[]): number {
  const pattern = new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?:[asuk](\\d+)-\\d+|c(\\d+))$`)
  let next = 0
  for (const message of messages) {
    const match = pattern.exec(message.id)
    if (!match) continue
    const index = Number(match[1] ?? match[2])
    if (Number.isFinite(index)) next = Math.max(next, index + 1)
  }
  return next
}

function compactionMessage(id: string, compaction: RunCompaction): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: compaction.summary ?? `The context could not be compacted: ${compaction.error ?? 'unknown error'}`,
      },
    ],
    metadata: {
      chatStatus: 'done',
      compaction: {
        at: compaction.at,
        replacedCount: compaction.replacedCount,
        tokensBefore: compaction.tokensBefore,
        ...(compaction.error !== undefined ? { error: compaction.error } : {}),
      },
    },
  }
}

export function isCompactionMessage(message: UIMessage): boolean {
  return (message.metadata as { compaction?: unknown } | undefined)?.compaction !== undefined
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
  const events = [
    ...pass.steers.map((steer, index) => ({
      step: steer.step,
      message: userMessage(`${runId}-s${passIndex}-${index}`, steer.text),
    })),
    ...(pass.compactions ?? []).map((compaction, index) => ({
      step: compaction.step,
      message: compactionMessage(`${runId}-k${passIndex}-${index}`, compaction),
    })),
  ].sort((a, b) => a.step - b.step)
  for (const event of events) {
    const at = Math.max(start, stepOffset(parts, event.step))
    pushAssistant(parts.slice(start, at))
    messages.push(event.message)
    start = at
  }
  pushAssistant(parts.slice(start))
  pass.after.forEach((text, afterIndex) => {
    messages.push(userMessage(`${runId}-u${passIndex}-${afterIndex}`, text))
  })
  return messages
}

export interface RunSeed {
  messages: UIMessage[]
  text: string
  passOffset: number
}

export function openingMessages(runId: string, prompt: string, seed?: RunSeed): UIMessage[] {
  return seed
    ? [...seed.messages, continuationMessage(runId, seed.passOffset, seed.text)]
    : [promptMessage(runId, prompt)]
}

export function buildRunMessages(
  runId: string,
  prompt: string,
  passes: readonly RunPass[],
  seed?: RunSeed,
): UIMessage[] {
  const offset = seed?.passOffset ?? 0
  return [
    ...openingMessages(runId, prompt, seed),
    ...passes.flatMap((pass, passIndex) => passMessages(runId, offset + passIndex, pass)),
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
