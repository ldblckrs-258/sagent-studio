import { embed } from 'ai'
import type { EmbeddingModel } from 'ai'
import { RagIndexError } from './index-cache'

export { cosineTopK, RagIndexError } from './index-cache'
export type { CosineHit, CosineResult } from './index-cache'

export interface EmbedQueryOptions {
  signal?: AbortSignal
}

/**
 * Embeds a query with the configured provider. This is the only network step in
 * retrieval; hydration, listing, reading, and the cosine scan are all local.
 */
export async function embedQuery(
  model: EmbeddingModel,
  text: string,
  options: EmbedQueryOptions = {},
): Promise<number[]> {
  const query = text.trim()
  if (!query) throw new RagIndexError('A non-empty query is required.')
  const result = await embed({ model, value: query, abortSignal: options.signal })
  return result.embedding
}
