import type { UIMessage } from 'ai'
import { messagesSinceBoundary } from './boundary'
import type { ChatMessageMetadata } from './sanitize'

/**
 * A single turn's accounting. Every token field is optional because an
 * OpenAI-compatible server may omit usage entirely; `estimated` records whether
 * the numbers came from the provider or from this module's own estimate, so the
 * UI can label a derived figure instead of presenting it as measured.
 */
export type TurnUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /**
   * What the next request will actually carry, which is not derivable from the
   * fields above. A turn can take several model steps, and the provider's
   * `totalUsage.inputTokens` is the sum of every step's prompt, so it counts the
   * same conversation once per step. This is the final step's own prompt plus
   * its output: the one measurement that describes the conversation's size.
   */
  contextTokens?: number
  durationMs?: number
  tokensPerSecond?: number
  estimated: boolean
}

/** Context size with its provenance, so a caller never has to re-derive the flag. */
export type ContextUsage = {
  tokens: number
  estimated: boolean
}

/** Usage as the AI SDK's finish part reports it, with every field optional. */
export type ProviderUsage = {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}

/**
 * Characters per token. Four is the conventional English approximation for
 * byte-pair encodings and is deliberately coarse: it exists so auto-compaction
 * still has a number to compare against a cap when the provider reports none,
 * not to match a tokenizer. Every figure derived from it is flagged
 * `estimated`.
 */
const CHARS_PER_TOKEN = 4

type MessagePart = UIMessage['parts'][number]

function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function partType(part: MessagePart): string {
  return typeof (part as { type?: unknown }).type === 'string'
    ? (part as { type: string }).type
    : ''
}

/**
 * The characters a part contributes to the request. Mirrors what
 * `convertToModelMessages` sends: prose for text and reasoning, and the
 * serialized input plus result for a tool call. A part the model never sees
 * contributes nothing.
 */
function requestCharsOfPart(part: MessagePart): number {
  const record = part as unknown as Record<string, unknown>
  const type = partType(part)
  if (type === 'text' || type === 'reasoning') {
    return typeof record.text === 'string' ? record.text.length : 0
  }
  if (type === 'dynamic-tool' || type.startsWith('tool-')) {
    let chars = type.length
    if (record.input !== undefined) chars += serialize(record.input).length
    if (record.output !== undefined) chars += serialize(record.output).length
    if (typeof record.errorText === 'string') chars += record.errorText.length
    return chars
  }
  return 0
}

/** Rendered output characters, which drive the live rate before usage arrives. */
export function outputCharsOf(message: UIMessage): number {
  let chars = 0
  for (const part of message.parts) {
    const type = partType(part)
    if (type !== 'text' && type !== 'reasoning') continue
    const text = (part as unknown as { text?: unknown }).text
    if (typeof text === 'string') chars += text.length
  }
  return chars
}

/** The divisor applied to a character count, for callers that already have one. */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length)
}

export function estimateMessagesTokens(messages: readonly UIMessage[]): number {
  let chars = 0
  for (const message of messages) {
    for (const part of message.parts) chars += requestCharsOfPart(part)
  }
  return estimateTokensFromChars(chars)
}

export function usageOf(message: UIMessage): TurnUsage | undefined {
  return (message.metadata as ChatMessageMetadata | undefined)?.usage
}

/**
 * Builds a turn's usage from the provider's report. A provider that returns no
 * counts still yields a record (for the duration), but leaves the token fields
 * absent and marks itself estimated, so `contextTokensOf` falls through to the
 * character estimate rather than reading zero tokens as a measured zero.
 */
export function turnUsageFrom(
  provider: ProviderUsage | undefined,
  durationMs: number,
  lastStep?: ProviderUsage | undefined,
): TurnUsage {
  const inputTokens = provider?.inputTokens
  const outputTokens = provider?.outputTokens
  const totalTokens =
    provider?.totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  const measured =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    provider?.totalTokens !== undefined
  // The rate is the turn's whole output over its wall time, which is what the
  // user watched happen.
  const tokensPerSecond =
    outputTokens !== undefined && durationMs > 0
      ? outputTokens / (durationMs / 1000)
      : undefined
  // A single-step turn's last step is the turn, so this equals input + output
  // there and only diverges once a turn takes several steps.
  const step = lastStep ?? provider
  const contextTokens =
    step?.inputTokens !== undefined || step?.outputTokens !== undefined
      ? (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0)
      : undefined
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(durationMs > 0 ? { durationMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    estimated: !measured,
  }
}

/** Every recorded turn summed. Turns without usage contribute nothing. */
export function totalTokensOf(messages: readonly UIMessage[]): number {
  let total = 0
  for (const message of messages) {
    const usage = usageOf(message)
    if (!usage) continue
    total +=
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  }
  return total
}

/**
 * What the next request will carry.
 *
 * Measured from the newest assistant turn's `contextTokens` when the provider
 * reported usage. Otherwise estimated — and estimated over
 * `messagesSinceBoundary`, not the whole thread, because the request is sliced
 * at the boundary too. Estimating over everything would leave a compacted
 * thread reporting its pre-compaction size, so compaction would never lower the
 * number that triggered it and every later turn would compact again.
 */
export function contextTokensOf(messages: readonly UIMessage[]): ContextUsage {
  const window = messagesSinceBoundary(messages)
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const message = window[index]
    if (message.role !== 'assistant') continue
    const usage = usageOf(message)
    const measured =
      usage?.contextTokens ??
      (usage !== undefined &&
      (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : undefined)
    if (measured !== undefined) {
      return { tokens: measured, estimated: usage?.estimated ?? true }
    }
    break
  }
  return { tokens: estimateMessagesTokens(window), estimated: true }
}
