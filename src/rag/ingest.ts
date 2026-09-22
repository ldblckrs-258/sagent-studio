import type { EmbeddingModel } from 'ai'
import { embedPassages, probeEmbedding } from '../ai/embedder'
import { chunkText, resolveChunkParams } from './chunker'
import { extractPdfText, MAX_EXTRACTED_CHARS, MAX_FILE_BYTES, RagExtractionError } from './pdf'
import { deleteChunksForDocument, putDocumentAndChunks } from './store'
import type {
  ChunkDraft,
  DocumentKind,
  DocumentMeta,
  IngestProgress,
  IngestResult,
  StoredChunk,
} from './types'

export { MAX_EXTRACTED_CHARS, MAX_FILE_BYTES }

/** The structural shape of a picked file; `File` satisfies it. */
export interface IngestFile {
  name: string
  size: number
  type?: string
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export function kindOfFile(file: { name: string; type?: string }): DocumentKind {
  const name = file.name.toLowerCase()
  const type = (file.type ?? '').toLowerCase()
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf'
  if (
    name.endsWith('.md') ||
    name.endsWith('.markdown') ||
    type === 'text/markdown' ||
    type === 'text/x-markdown'
  ) {
    return 'markdown'
  }
  return 'text'
}

function titleOfFile(file: { name: string }): string {
  return file.name.replace(/\.(txt|text|md|markdown|pdf)$/i, '') || file.name
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'The document could not be ingested.'
}

const YIELD_EVERY = 32

/** Yield to the macrotask queue so a synchronous chunk-and-encrypt loop stays responsive. */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export interface IngestDocumentInput {
  id?: string
  file: IngestFile
  /** Pre-extracted text, mainly for tests; when absent the file is read. */
  text?: string
  embedder: EmbeddingModel
  chunkSize: number
  overlap: number
  embedProviderId: string
  embedModel: string
  /** Per-request token budget from the embedding model's window. */
  maxTokensPerCall?: number
  signal?: AbortSignal
  onProgress?: (progress: IngestProgress) => void
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Ingest aborted.')
  error.name = 'AbortError'
  throw error
}

/**
 * Extracts, chunks, embeds, encrypts, and persists one document. The chunk rows
 * and the document row are written atomically, so an interrupted ingest cannot
 * leave orphan chunks or a document without its chunks.
 */
export async function ingestDocument(input: IngestDocumentInput): Promise<IngestResult> {
  const {
    file,
    text,
    embedder,
    chunkSize,
    overlap,
    embedProviderId,
    embedModel,
    maxTokensPerCall,
    signal,
    onProgress,
  } = input
  const id = input.id ?? crypto.randomUUID()
  const kind = kindOfFile(file)
  const title = titleOfFile(file)
  // The persisted chunking parameters are the effective clamped values, so the
  // metadata always describes the chunks that were actually built.
  const effective = resolveChunkParams({ chunkSize, overlap })

  if (file.size > MAX_FILE_BYTES) {
    throw new RagExtractionError(
      `"${file.name}" is larger than the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB limit.`,
    )
  }

  try {
    onProgress?.({ phase: 'extracting', done: 0, total: 1 })
    let raw: string
    if (text !== undefined) {
      raw = text
    } else if (kind === 'pdf') {
      raw = await extractPdfText(await file.arrayBuffer(), signal)
    } else {
      raw = await file.text()
    }
    throwIfAborted(signal)
    if (raw.length > MAX_EXTRACTED_CHARS) {
      throw new RagExtractionError(
        `"${file.name}" extracts more than the ${MAX_EXTRACTED_CHARS.toLocaleString()} character limit.`,
      )
    }
    onProgress?.({ phase: 'extracting', done: 1, total: 1 })

    onProgress?.({ phase: 'chunking', done: 0, total: 1 })
    const drafts: ChunkDraft[] = chunkText(raw, effective)
    onProgress?.({ phase: 'chunking', done: 1, total: 1 })

    if (drafts.length === 0) {
      throw new RagExtractionError(`"${file.name}" contains no extractable text.`)
    }

    onProgress?.({ phase: 'embedding', done: 0, total: drafts.length })
    const { embeddings } = await embedPassages(
      embedder,
      drafts.map((draft) => draft.text),
      {
        signal,
        maxTokensPerCall,
        onProgress: (done, total) => onProgress?.({ phase: 'embedding', done, total }),
      },
    )
    throwIfAborted(signal)
    onProgress?.({ phase: 'embedding', done: drafts.length, total: drafts.length })

    const dims = embeddings[0]?.length ?? 0
    if (dims === 0) {
      throw new RagExtractionError('The embedding provider returned no vectors for this document.')
    }

    const now = Date.now()
    const chunks: StoredChunk[] = []
    for (let index = 0; index < drafts.length; index++) {
      const embedding = embeddings[index]
      if (!embedding || embedding.length !== dims) {
        throw new RagExtractionError('The embedding provider returned inconsistent vector sizes.')
      }
      chunks.push({
        id: crypto.randomUUID(),
        docId: id,
        ordinal: drafts[index].ordinal,
        dims,
        text: drafts[index].text,
        vector: Float32Array.from(embedding),
      })
      if ((index + 1) % YIELD_EVERY === 0) await yieldToMainThread()
    }

    onProgress?.({ phase: 'persisting', done: 0, total: chunks.length })
    const meta: DocumentMeta = {
      id,
      title,
      kind,
      sourceName: file.name,
      byteSize: file.size,
      chunkCount: chunks.length,
      chunkSize: effective.chunkSize,
      overlap: effective.overlap,
      embedProviderId,
      embedModel,
      dims,
      createdAt: now,
      updatedAt: now,
    }
    await putDocumentAndChunks(meta, chunks, (done, total) =>
      onProgress?.({ phase: 'persisting', done, total }),
    )
    onProgress?.({ phase: 'persisting', done: chunks.length, total: chunks.length })

    return { ok: true, id, title, kind, chunkCount: chunks.length, dims }
  } catch (error) {
    await deleteChunksForDocument(id).catch(() => undefined)
    throw error
  }
}

export interface IngestFilesInput {
  files: readonly IngestFile[]
  embedder: EmbeddingModel
  chunkSize: number
  overlap: number
  embedProviderId: string
  embedModel: string
  /** Per-request token budget from the embedding model's window. */
  maxTokensPerCall?: number
  signal?: AbortSignal
  onProgress?: (progress: IngestProgress) => void
}

/**
 * Ingests files sequentially, reporting a per-file result without aborting the
 * batch. Runs the one-item embedding probe once before the first file, so a
 * provider that serves no embedding model fails with a named error rather than
 * a partial write.
 */
export async function ingestFiles(input: IngestFilesInput): Promise<IngestResult[]> {
  const {
    files,
    embedder,
    chunkSize,
    overlap,
    embedProviderId,
    embedModel,
    maxTokensPerCall,
    signal,
    onProgress,
  } = input
  const results: IngestResult[] = []
  if (files.length === 0) return results

  await probeEmbedding(embedder, { providerId: embedProviderId, modelId: embedModel, signal })

  for (const file of files) {
    try {
      results.push(
        await ingestDocument({
          file,
          embedder,
          chunkSize,
          overlap,
          embedProviderId,
          embedModel,
          maxTokensPerCall,
          signal,
          onProgress,
        }),
      )
    } catch (error) {
      results.push({
        ok: false,
        title: titleOfFile(file),
        kind: kindOfFile(file),
        error: describeError(error),
      })
    }
  }
  return results
}
