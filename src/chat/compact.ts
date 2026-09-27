import { convertToModelMessages, generateId, generateText } from 'ai'
import type { UIMessage } from 'ai'
import { createLLM } from '../ai/llm'
import { messagesSinceBoundary } from './boundary'
import type { CompactionMeta } from './boundary'
import type { PipelineDeps } from './engine'
import { ChatError } from './errors'
import type { ChatMessageMetadata } from './sanitize'
import type { ChatThread, ThreadConfig } from './types'
import { convertAgentNoticePart } from './types'
import { contextTokensOf } from './usage'

export {
  findBoundaryIndex,
  messagesSinceBoundary,
  splitTrailingUserTurn,
} from './boundary'
export type { CompactionMeta } from './boundary'

const SUMMARY_SYSTEM = `You compact a coding assistant's conversation into a briefing the same assistant will continue from. Cover, under short headings:

- Decisions: what was decided and why.
- State: what is finished, what is in progress, and what has not started.
- Open threads: unresolved questions, failures, and anything the user asked for that is still outstanding.
- Files: every path touched and what changed in it.

Preserve identifiers, paths, commands, and error strings exactly. Record only what the conversation contains; invent nothing. Write the briefing itself, with no preamble.`

const SUMMARY_REQUEST =
  'Compact the conversation above into the briefing described in your instructions.'

export async function summarizeMessages(
  deps: PipelineDeps,
  config: ThreadConfig,
  messages: readonly UIMessage[],
  instructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const settings = deps.getSettings()
  if (!settings) throw new ChatError('The vault is locked; the thread cannot be compacted.')

  const modelFactory = deps.modelFactory ?? createLLM
  const model = modelFactory(settings, config.providerId, config.modelId)
  const history = await convertToModelMessages([...messages], {
    ignoreIncompleteToolCalls: true,
    convertDataPart: convertAgentNoticePart,
  })
  const request =
    instructions !== undefined && instructions.trim().length > 0
      ? `${SUMMARY_REQUEST}\n\nThe user asked you to focus on: ${instructions.trim()}`
      : SUMMARY_REQUEST

  const result = await generateText({
    model,
    system: SUMMARY_SYSTEM,
    messages: [...history, { role: 'user', content: request }],
    ...config.params,
    ...(signal ? { abortSignal: signal } : {}),
  })

  const summary = result.text.trim()
  // An empty summary would produce a boundary that hides the history behind
  // nothing at all, which is worse than not compacting.
  if (summary.length === 0) {
    throw new ChatError('The model returned an empty summary; the thread was left unchanged.')
  }
  return summary
}

/**
 * Appends a summary boundary. The stored thread keeps every message; only what
 * the next request sends changes, which is why this is reversible and why a
 * failure can simply propagate: the new array is built after the summary
 * resolves, so a rejection leaves `thread` untouched.
 */
export async function compactThread(
  deps: PipelineDeps,
  thread: ChatThread,
  instructions?: string,
  signal?: AbortSignal,
): Promise<ChatThread> {
  const window = messagesSinceBoundary(thread.messages)
  if (window.length === 0) {
    throw new ChatError('There is nothing to compact in this conversation yet.')
  }
  const tokensBefore = contextTokensOf(thread.messages).tokens
  const summary = await summarizeMessages(
    deps,
    thread.config,
    window,
    instructions,
    signal,
  )

  const compaction: CompactionMeta = {
    at: Date.now(),
    replacedCount: window.length,
    tokensBefore,
    ...(instructions !== undefined && instructions.trim().length > 0
      ? { instructions: instructions.trim() }
      : {}),
  }
  const boundary: UIMessage = {
    id: generateId(),
    role: 'assistant',
    parts: [{ type: 'text', text: summary }],
    metadata: { chatStatus: 'done', compaction } satisfies ChatMessageMetadata,
  }
  return {
    ...thread,
    messages: [...thread.messages, boundary],
    updatedAt: Date.now(),
  }
}
