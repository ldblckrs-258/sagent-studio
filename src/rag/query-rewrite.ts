import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

/**
 * LLM query rewriting for a user-sourced RAG search.
 *
 * This is deliberately separate from the Jev `selectQuery` step: Jev picks
 * among code-generated candidate formulations with a judgment, while this asks
 * a language model to produce one improved formulation. It runs only when the
 * caller marks the search as coming from the raw user message, so an
 * agent-authored `search_documents` query is never rewritten.
 */

/** Longest slice of conversation context fed to the rewriter. */
export const MAX_REWRITE_CONTEXT_CHARS = 2000

export function buildQueryRewritePrompt(query: string, context?: string): string {
  const lines = [
    'Rewrite the user search query so a vector search over the local document library returns the passages that answer it.',
    'Keep the meaning, proper nouns, and numbers; add useful synonyms or expanded terms.',
    'Output one line of plain text only, with no quotes and no explanation.',
    'If the query is already clear, return it unchanged.',
  ]
  if (context !== undefined && context.trim() !== '') {
    lines.push('', `Conversation context: ${context.slice(0, MAX_REWRITE_CONTEXT_CHARS)}`)
  }
  lines.push('', `Query: ${query}`, '', 'Rewritten query:')
  return lines.join('\n')
}

export interface RewriteQueryOptions {
  context?: string
  signal?: AbortSignal
}

/**
 * Returns the rewritten query as a single trimmed line. Throws on a model or
 * abort error; the caller falls back to the original query.
 */
export async function rewriteQuery(
  model: LanguageModel,
  query: string,
  options: RewriteQueryOptions = {},
): Promise<string> {
  const { text } = await generateText({
    model,
    prompt: buildQueryRewritePrompt(query, options.context),
    // Generous: a reasoning model spends part of the budget on hidden reasoning
    // before emitting the one-line query, so a tight cap can return no text.
    maxOutputTokens: 1024,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  })
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}
