import { create } from 'zustand'
import type { EmbeddingModel } from 'ai'
import { createEmbedder, embedPassages, embedTokenBudget, probeEmbedding } from '../ai/embedder'
import type { Settings } from '../vault/settings'
import { useVaultStore } from '../vault/store'
import { addVectors, clear as clearIndexCache, hydrate, removeDocument as removeIndexDocument } from './index-cache'
import type { VectorEntry } from './index-cache'
import { ingestFiles, type IngestFile } from './ingest'
import { resolveEmbedProviderId } from './port'
import {
  deleteDocument,
  listDocuments,
  putDocumentAndChunks,
  readChunkVectorsForDocument,
  readDocumentChunkTexts,
  type DocumentChunkText,
} from './store'
import type { DocumentMeta, IngestProgress, IngestResult, StoredChunk } from './types'

export type LibraryStatus = 'idle' | 'loading' | 'ingesting' | 'error'

export interface DocumentLibraryState {
  documents: DocumentMeta[]
  status: LibraryStatus
  progress: IngestProgress | null
  error: string | null
  refresh(): Promise<void>
  addFiles(files: readonly IngestFile[]): Promise<void>
  /** Re-embeds every document with the current model and rebuilds the index. */
  reindex(): Promise<void>
  remove(id: string): Promise<void>
  clear(): void
}

export interface IngestRequest {
  embedder: EmbeddingModel
  chunkSize: number
  overlap: number
  embedProviderId: string
  embedModel: string
  maxTokensPerCall?: number
  signal?: AbortSignal
  onProgress?: (progress: IngestProgress) => void
}

export interface DocumentLibraryDeps {
  getSettings(): Settings | null
  list(): Promise<DocumentMeta[]>
  remove(id: string): Promise<void>
  readVectors(docId: string): Promise<VectorEntry[]>
  readChunkTexts(docId: string): Promise<DocumentChunkText[]>
  replaceDocument(meta: DocumentMeta, chunks: StoredChunk[]): Promise<void>
  ingest(files: readonly IngestFile[], request: IngestRequest): Promise<IngestResult[]>
  addVectors(entries: readonly VectorEntry[]): Promise<void>
  removeVectorsForDocument(docId: string): Promise<void>
  embedderFor(settings: Settings): EmbeddingModel
  resolveProviderId(settings: Settings): string
  embedTexts(
    embedder: EmbeddingModel,
    texts: readonly string[],
    options: { signal?: AbortSignal; maxTokensPerCall?: number },
  ): Promise<number[][]>
  probe(embedder: EmbeddingModel, options: { providerId: string; modelId: string }): Promise<number>
  clearIndex(): void
  hydrateIndex(): Promise<void>
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'The library operation failed.'
}

/**
 * The library store owns the live vector index alongside the metadata list: a
 * successful ingest adds vectors, a delete evicts them, and a model change
 * re-embeds the corpus, so the index never disagrees with the store. One
 * embedding model governs the whole library — a query vector can only be
 * compared with same-dimension passages — so a changed model triggers a
 * re-index rather than a mixed store. `clear()` runs in the session cleanup so
 * decrypted titles do not survive a lock.
 */
export function createDocumentLibraryStore(deps: DocumentLibraryDeps) {
  // One in-flight ingest/re-index at a time; a new run or a clear aborts the previous.
  let controller: AbortController | null = null
  return create<DocumentLibraryState>((set, get) => ({
    documents: [],
    status: 'idle',
    progress: null,
    error: null,

    async refresh() {
      set({ status: 'loading' })
      try {
        const documents = await deps.list()
        set({ documents, status: 'idle', error: null })
      } catch (error) {
        set({ status: 'error', error: describe(error) })
      }
    },

    async reindex() {
      const settings = deps.getSettings()
      if (!settings) {
        set({ status: 'error', error: 'Unlock the vault before re-indexing.' })
        return
      }
      let embedder: EmbeddingModel
      let providerId: string
      try {
        providerId = deps.resolveProviderId(settings)
        embedder = deps.embedderFor(settings)
      } catch (error) {
        set({ status: 'error', error: describe(error) })
        return
      }

      controller?.abort()
      controller = new AbortController()
      set({ status: 'ingesting', progress: null, error: null })
      try {
        const documents = await deps.list()
        for (let index = 0; index < documents.length; index++) {
          const document = documents[index]
          const chunks = await deps.readChunkTexts(document.id)
          if (chunks.length === 0) continue
          const embeddings = await deps.embedTexts(
            embedder,
            chunks.map((chunk) => chunk.text),
            {
              signal: controller.signal,
              maxTokensPerCall: embedTokenBudget(settings, providerId, settings.rag.embedModel),
            },
          )
          const dims = embeddings[0]?.length ?? document.dims
          if (dims === 0) throw new Error('The embedding provider returned no vectors during re-index.')
          const stored: StoredChunk[] = chunks.map((chunk, chunkIndex) => {
            const embedding = embeddings[chunkIndex]
            if (!embedding || embedding.length !== dims) {
              throw new Error('The embedding provider returned inconsistent vector sizes during re-index.')
            }
            return {
              id: chunk.id,
              docId: document.id,
              ordinal: chunk.ordinal,
              dims,
              text: chunk.text,
              vector: Float32Array.from(embedding),
            }
          })
          await deps.replaceDocument(
            {
              ...document,
              dims,
              embedProviderId: providerId,
              embedModel: settings.rag.embedModel,
              chunkCount: stored.length,
              updatedAt: Date.now(),
            },
            stored,
          )
          set({ progress: { phase: 'embedding', done: index + 1, total: documents.length } })
        }
        // Every document is now on one model, so rebuild the index from scratch.
        deps.clearIndex()
        await deps.hydrateIndex()
        await get().refresh()
        set({ status: 'idle', error: null, progress: null })
      } catch (error) {
        set({ status: 'error', error: describe(error), progress: null })
      }
    },

    async addFiles(files) {
      if (files.length === 0) return
      const settings = deps.getSettings()
      if (!settings) {
        set({ status: 'error', error: 'Unlock the vault before adding documents.' })
        return
      }
      let embedder: EmbeddingModel
      let providerId: string
      try {
        providerId = deps.resolveProviderId(settings)
        embedder = deps.embedderFor(settings)
      } catch (error) {
        set({ status: 'error', error: describe(error) })
        return
      }

      // A query vector can only be scored against same-dimension passages, so a
      // changed embedding model must re-embed the existing library before the
      // new documents are added, or the store ends up with mixed dimensions.
      try {
        const existing = await deps.list()
        if (existing.length > 0) {
          const probeDims = await deps.probe(embedder, {
            providerId,
            modelId: settings.rag.embedModel,
          })
          if (existing.some((document) => document.dims !== probeDims)) {
            await get().reindex()
            if (get().status === 'error') return
          }
        }
      } catch (error) {
        set({ status: 'error', error: describe(error), progress: null })
        return
      }

      controller?.abort()
      controller = new AbortController()
      set({ status: 'ingesting', progress: null, error: null })
      try {
        const results = await deps.ingest(files, {
          embedder,
          chunkSize: settings.rag.chunkSize,
          overlap: settings.rag.overlap,
          embedProviderId: providerId,
          embedModel: settings.rag.embedModel,
          maxTokensPerCall: embedTokenBudget(settings, providerId, settings.rag.embedModel),
          signal: controller.signal,
          onProgress: (progress) => set({ progress }),
        })
        const problems: string[] = []
        for (const result of results) {
          if (!result.ok) {
            problems.push(`${result.title}: ${result.error}`)
            continue
          }
          try {
            const vectors = await deps.readVectors(result.id)
            await deps.addVectors(vectors)
          } catch (error) {
            // The document is stored; only the live index could not be updated.
            problems.push(`${result.title}: ${describe(error)}`)
          }
        }
        await get().refresh()
        set({
          status: problems.length > 0 ? 'error' : 'idle',
          error: problems.length > 0 ? problems.join(' ') : null,
          progress: null,
        })
      } catch (error) {
        // A named probe failure (no embedding model) surfaces here without
        // clearing the existing list.
        set({ status: 'error', error: describe(error), progress: null })
      }
    },

    async remove(id) {
      try {
        await deps.remove(id)
        await deps.removeVectorsForDocument(id)
        await get().refresh()
      } catch (error) {
        set({ status: 'error', error: describe(error) })
      }
    },

    clear() {
      controller?.abort()
      controller = null
      set({ documents: [], status: 'idle', progress: null, error: null })
    },
  }))
}

export const useDocumentLibraryStore = createDocumentLibraryStore({
  getSettings: () => useVaultStore.getState().settings,
  list: () => listDocuments(),
  remove: (id) => deleteDocument(id),
  readVectors: (docId) => readChunkVectorsForDocument(docId),
  readChunkTexts: (docId) => readDocumentChunkTexts(docId),
  replaceDocument: (meta, chunks) => putDocumentAndChunks(meta, chunks),
  ingest: (files, request) =>
    ingestFiles({
      files,
      embedder: request.embedder,
      chunkSize: request.chunkSize,
      overlap: request.overlap,
      embedProviderId: request.embedProviderId,
      embedModel: request.embedModel,
      signal: request.signal,
      onProgress: request.onProgress,
    }),
  addVectors: (entries) => addVectors(entries),
  removeVectorsForDocument: (docId) => removeIndexDocument(docId),
  embedderFor: (settings) => createEmbedder(settings, resolveEmbedProviderId(settings)),
  resolveProviderId: (settings) => resolveEmbedProviderId(settings),
  embedTexts: async (embedder, texts, options) => {
    const result = await embedPassages(embedder, texts, {
      signal: options.signal,
      maxTokensPerCall: options.maxTokensPerCall,
    })
    return result.embeddings
  },
  probe: (embedder, options) =>
    probeEmbedding(embedder, { providerId: options.providerId, modelId: options.modelId }),
  clearIndex: () => clearIndexCache(),
  hydrateIndex: () => hydrate(),
})
