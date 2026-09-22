import { generateText } from 'ai'
import type { LanguageModel, UIMessage } from 'ai'
import { createTierModel } from '../ai/model-tier'
import type { ModelFactory } from '../ai/model-tier'
import { createLLM } from '../ai/llm'
import type { Settings } from '../vault/settings'
import { extractText } from './convert'
import type { IncomingContent } from './convert'
import { DEFAULT_TITLE, MAX_TITLE_LENGTH, normalizeTitle } from './threads'
import type { ChatThread } from './types'

/**
 * Conversation title generation.
 *
 * Runs once, after the first successful reply, and never over a title the user
 * chose: the caller only invokes it while the title is still `New chat`. The
 * cheap model tier does the work when one is configured; otherwise the
 * conversation's own model is used so the feature works unconfigured. The whole
 * path is best-effort — a failure must not surface as a chat error.
 */

/** Longest slice of a message fed to the prompt; titles need only the gist. */
export const MAX_TITLE_PROMPT_CHARS = 600

/** Re-name the conversation every this many user turns, after the first name. */
export const RENAME_EVERY_USER_MESSAGES = 5

/** Most recent messages included in a rename request; older turns are dropped. */
export const MAX_RENAME_CONTEXT_MESSAGES = 6

/** Total character budget for the rename transcript, oldest turns dropped first. */
export const MAX_RENAME_CONTEXT_CHARS = 1600

function textOfParts(message: UIMessage): string {
  try {
    return extractText(message.parts as unknown as IncomingContent).trim()
  } catch {
    return ''
  }
}

/** How many user turns the conversation has. The rename cadence counts these. */
export function countUserMessages(thread: ChatThread): number {
  let count = 0
  for (const message of thread.messages) if (message.role === 'user') count += 1
  return count
}

/**
 * Whether the naming task should run for this thread now. False for a title the
 * user claimed, for a thread with no user turn yet, and for a turn that was
 * already named. True for the first named turn, then every fifth user turn.
 */
export function shouldGenerateTitle(thread: ChatThread): boolean {
  if (thread.titleSource === 'user') return false
  const count = countUserMessages(thread)
  if (count === 0) return false
  if (thread.title !== DEFAULT_TITLE) {
    if (thread.titleUserCount === count) return false
    return count % RENAME_EVERY_USER_MESSAGES === 0
  }
  return true
}

/**
 * A bounded transcript of the most recent turns, so a rename request does not
 * grow with the conversation. Only the last `MAX_RENAME_CONTEXT_MESSAGES`
 * messages are considered, each clamped to `MAX_TITLE_PROMPT_CHARS`, and the
 * oldest turns are dropped while the total exceeds `MAX_RENAME_CONTEXT_CHARS`.
 */
export function formatTranscript(thread: ChatThread): string {
  const recent = thread.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role as 'user' | 'assistant', text: textOfParts(message) }))
    .filter((message) => message.text !== '')
    .slice(-MAX_RENAME_CONTEXT_MESSAGES)
  const entries = recent.map(
    (message) =>
      `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, MAX_TITLE_PROMPT_CHARS)}`,
  )
  while (entries.length > 1 && entries.join('\n').length > MAX_RENAME_CONTEXT_CHARS) {
    entries.shift()
  }
  return entries.join('\n')
}

/** The first user message's text, capped for the prompt. Empty when none. */
export function firstUserText(thread: ChatThread): string {
  for (const message of thread.messages) {
    if (message.role !== 'user') continue
    const text = textOfParts(message)
    if (text !== '') return text.slice(0, MAX_TITLE_PROMPT_CHARS)
  }
  return ''
}

/** The first assistant message that carries text, capped for the prompt. */
export function firstAssistantText(thread: ChatThread): string {
  for (const message of thread.messages) {
    if (message.role !== 'assistant') continue
    const text = textOfParts(message)
    if (text !== '') return text.slice(0, MAX_TITLE_PROMPT_CHARS)
  }
  return ''
}

export function buildTitlePrompt(transcript: string): string {
  // Terse and imperative on purpose: a reasoning model that is handed a list of
  // rules tends to reason about each one, burning the whole budget before it
  // emits a title. A single short instruction with "answer immediately" is the
  // cheapest way to get straight to the answer across both chat and reasoning
  // models.
  return [
    'Answer immediately with a 3-6 word title for this chat.',
    'Output only the title — no reasoning, no quotes, no punctuation.',
    '',
    transcript,
    '',
    'Title:',
  ].join('\n')
}

/**
 * Reduces a model reply to a single clean title line: first non-empty line, an
 * optional `Title:` prefix removed, surrounding quotes stripped, trailing
 * punctuation dropped, then clamped to the title limit.
 */
export function cleanTitle(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const stripped = firstLine
    .replace(/^title\s*[::]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim()
  return stripped.slice(0, MAX_TITLE_LENGTH)
}

/**
 * The model that writes the title: the configured cheap tier when usable,
 * otherwise the conversation's own provider/model. Null when neither resolves.
 */
export function titleModel(
  settings: Settings,
  thread: ChatThread,
  factory: ModelFactory = createLLM,
): LanguageModel | null {
  const cheap = createTierModel(settings, 'cheap', factory)
  if (cheap) return cheap
  try {
    return factory(settings, thread.config.providerId, thread.config.modelId)
  } catch {
    return null
  }
}

export interface GenerateTitleOptions {
  settings: Settings
  thread: ChatThread
  factory?: ModelFactory
  signal?: AbortSignal
}

/**
 * Returns a normalized title, or null when there is nothing to name, no model
 * resolves, or the model returns an unusable reply. Throws only on a model or
 * abort error; the engine caller swallows those.
 */
export async function generateConversationTitle(
  options: GenerateTitleOptions,
): Promise<string | null> {
  const { settings, thread } = options
  if (countUserMessages(thread) === 0) return null
  const transcript = formatTranscript(thread)
  if (transcript === '') return null
  const model = titleModel(settings, thread, options.factory ?? createLLM)
  if (!model) return null
  const { text } = await generateText({
    model,
    prompt: buildTitlePrompt(transcript),
    // A reasoning model spends part of this budget on hidden reasoning before
    // it emits the title; a small cap (e.g. 32) can be consumed entirely by
    // reasoning and return `content: null` with `finish_reason: "length"`.
    maxOutputTokens: 1024,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  })
  const title = cleanTitle(text ?? '')
  if (title === '' || title === DEFAULT_TITLE) return null
  return normalizeTitle(title)
}
