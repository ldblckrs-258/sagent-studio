import type { UIMessage } from 'ai'

/**
 * Compaction boundary geometry. This lives apart from `compact.ts` because
 * `usage.ts` has to slice at the boundary to measure context, and `compact.ts`
 * needs `usage.ts` to record what a boundary replaced; a shared module is what
 * keeps that from becoming a cycle. Metadata is read structurally here for the
 * same reason.
 */

/** Marks the message that carries a compaction summary. */
export type CompactionMeta = {
  at: number
  replacedCount: number
  tokensBefore: number
  instructions?: string
  error?: string
}

function isBoundary(message: UIMessage): boolean {
  return (
    (message.metadata as { compaction?: unknown } | undefined)?.compaction !==
    undefined
  )
}

/** The index of the newest compaction boundary, or -1 when the thread has none. */
export function findBoundaryIndex(messages: readonly UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isBoundary(messages[index])) return index
  }
  return -1
}

/**
 * What the model is allowed to see: the summary plus everything after it. The
 * boundary itself is included because it is the only carrier of the history it
 * replaced.
 */
export function messagesSinceBoundary(messages: readonly UIMessage[]): UIMessage[] {
  const boundary = findBoundaryIndex(messages)
  return boundary === -1 ? [...messages] : messages.slice(boundary)
}

/**
 * Splits off the turn the model is being asked to answer. A run's base array
 * ends with the user's pending message (or messages, after an edit), and a
 * boundary appended past them would leave `messagesSinceBoundary` returning the
 * summary alone with the question dropped. Auto-compaction therefore summarizes
 * `history` and re-attaches `tail` after the boundary.
 *
 * A skill directive is also a user message, so it travels in `tail` too. That
 * is deliberate: the directive has to land after the boundary or the model
 * never sees the instruction it is meant to follow.
 */
export function splitTrailingUserTurn(messages: readonly UIMessage[]): {
  history: UIMessage[]
  tail: UIMessage[]
} {
  let index = messages.length
  while (index > 0 && messages[index - 1].role === 'user') index -= 1
  return { history: messages.slice(0, index), tail: messages.slice(index) }
}
