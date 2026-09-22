import { db } from '../vault/db'
import type { ChunkRecord } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { decryptRecord, decryptRecordBytes, encryptRecord, encryptRecordBytes } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import type { Bytes } from '../vault/types'
import type { DocumentMeta, StoredChunk } from './types'

export class RagStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RagStoreError'
  }
}

export const docSeed = (id: string): string => `doc:${id}`
export const chunkTextSeed = (id: string): string => `doc-chunk-text:${id}`
export const chunkVectorSeed = (id: string): string => `doc-chunk-vector:${id}`

function float32ToBytes(vector: Float32Array): Bytes {
  const copy = new Float32Array(vector)
  return new Uint8Array(copy.buffer)
}

function bytesToFloat32(bytes: Bytes, dims: number): Float32Array {
  const copy = new Uint8Array(bytes)
  if (copy.byteLength !== dims * 4) {
    throw new RagStoreError(
      `Stored vector length ${copy.byteLength} does not match its recorded dimension ${dims}.`,
    )
  }
  return new Float32Array(copy.buffer)
}

function parseMeta(json: string): DocumentMeta {
  try {
    return JSON.parse(json) as DocumentMeta
  } catch (cause) {
    throw new RagStoreError('A stored document record was not valid JSON.', { cause })
  }
}

/**
 * Runs a write task on the shared queue, asserting the keyring identity before
 * the queue and again inside it — mirroring `useVaultStore.update` — so a lock
 * that lands mid-write cannot land rows under a cleared key.
 */
async function guardedWrite(task: () => Promise<void>): Promise<void> {
  const currentKey = keyring.getKey()
  if (!currentKey) throw new VaultLockedError()
  await vaultWriteQueue.enqueue(async () => {
    if (keyring.getKey() !== currentKey) throw new VaultLockedError()
    await task()
  })
}

function isQuotaError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'QuotaExceededError'
}

/** Yield to the macrotask queue so a synchronous encrypt loop stays responsive. */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const YIELD_EVERY = 32

function describeWriteError(cause: unknown): unknown {
  if (isQuotaError(cause)) {
    return new RagStoreError('Browser storage quota exceeded while saving the document.', { cause })
  }
  return cause
}

/** Encrypts and writes a document row and all its chunk rows as one atomic unit. */
export async function putDocumentAndChunks(
  meta: DocumentMeta,
  chunks: StoredChunk[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const docBlob = await encryptRecord(JSON.stringify(meta), docSeed(meta.id))
  const rows: ChunkRecord[] = []
  onProgress?.(0, chunks.length)
  // Encrypt in bounded parallel batches: the two AES-GCM operations per chunk
  // are independent, and a batch boundary doubles as the macrotask yield so a
  // large ingest never pins the main thread.
  for (let start = 0; start < chunks.length; start += YIELD_EVERY) {
    const batch = chunks.slice(start, start + YIELD_EVERY)
    const encrypted = await Promise.all(
      batch.map(async (chunk) => ({
        id: chunk.id,
        docId: chunk.docId,
        ordinal: chunk.ordinal,
        dims: chunk.dims,
        text: await encryptRecord(chunk.text, chunkTextSeed(chunk.id)),
        vector: await encryptRecordBytes(float32ToBytes(chunk.vector), chunkVectorSeed(chunk.id)),
        updatedAt: meta.updatedAt,
      })),
    )
    rows.push(...encrypted)
    onProgress?.(rows.length, chunks.length)
    await yieldToMainThread()
  }
  await guardedWrite(async () => {
    try {
      await db.transaction('rw', db.documents, db.chunks, async () => {
        // Replace semantics: remove any prior chunks for this id in the same
        // transaction, so a re-ingest never leaves stale chunks behind.
        await db.chunks.where('docId').equals(meta.id).delete()
        await db.chunks.bulkPut(rows)
        await db.documents.put({ id: meta.id, blob: docBlob, updatedAt: meta.updatedAt })
      })
    } catch (cause) {
      throw describeWriteError(cause)
    }
  })
}

/** Saves or replaces one document's encrypted metadata row. */
export async function saveDocument(meta: DocumentMeta): Promise<void> {
  const blob = await encryptRecord(JSON.stringify(meta), docSeed(meta.id))
  await guardedWrite(async () => {
    await db.documents.put({ id: meta.id, blob, updatedAt: meta.updatedAt })
  })
}

/** Removes a document and every chunk that belongs to it, atomically. */
export async function deleteDocument(id: string): Promise<void> {
  await guardedWrite(async () => {
    await db.transaction('rw', db.documents, db.chunks, async () => {
      await db.chunks.where('docId').equals(id).delete()
      await db.documents.delete(id)
    })
  })
}

/** Best-effort removal of a document's chunks, used to clean up a failed ingest. */
export async function deleteChunksForDocument(docId: string): Promise<void> {
  await guardedWrite(async () => {
    await db.chunks.where('docId').equals(docId).delete()
  })
}

/** Lists every document, newest first, decrypting each metadata blob. */
export async function listDocuments(): Promise<DocumentMeta[]> {
  const rows = await db.documents.orderBy('updatedAt').reverse().toArray()
  const metas: DocumentMeta[] = []
  for (const row of rows) {
    metas.push(parseMeta(await decryptRecord(row.blob, docSeed(row.id))))
  }
  return metas
}

export async function getDocument(id: string): Promise<DocumentMeta | null> {
  const row = await db.documents.get(id)
  if (!row) return null
  return parseMeta(await decryptRecord(row.blob, docSeed(id)))
}

/**
 * Chunk ids that still have a live document, so a caller never sees a chunk
 * without its document. Any orphan is left for `sweepOrphanChunks`.
 */
export async function listChunkIds(): Promise<string[]> {
  const docIds = new Set((await db.documents.toCollection().primaryKeys()) as string[])
  if (docIds.size === 0) return []
  const chunks = await db.chunks.toArray()
  const ids: string[] = []
  for (const chunk of chunks) if (docIds.has(chunk.docId)) ids.push(chunk.id)
  return ids
}

export async function getChunkRecord(id: string): Promise<StoredChunk | null> {
  const row = await db.chunks.get(id)
  if (!row) return null
  const text = await decryptRecord(row.text, chunkTextSeed(id))
  const bytes = await decryptRecordBytes(row.vector, chunkVectorSeed(id))
  return {
    id: row.id,
    docId: row.docId,
    ordinal: row.ordinal,
    dims: row.dims,
    text,
    vector: bytesToFloat32(bytes, row.dims),
  }
}

/** Decrypts only the vector of a chunk. */
export async function getChunkVector(id: string): Promise<Float32Array | null> {
  const row = await db.chunks.get(id)
  if (!row) return null
  const bytes = await decryptRecordBytes(row.vector, chunkVectorSeed(id))
  return bytesToFloat32(bytes, row.dims)
}

export interface VectorRow {
  id: string
  docId: string
  dims: number
  vector: Float32Array
}

async function decryptRowVector(row: {
  id: string
  docId: string
  dims: number
  vector: EncryptedBlobLike
}): Promise<VectorRow> {
  const bytes = await decryptRecordBytes(row.vector, chunkVectorSeed(row.id))
  return { id: row.id, docId: row.docId, dims: row.dims, vector: bytesToFloat32(bytes, row.dims) }
}

type EncryptedBlobLike = ChunkRecord['vector']

/**
 * Reads a page of chunk vectors with one IndexedDB query and decrypts them in
 * parallel, so hydration is batch-round-trip-bound rather than per-chunk.
 */


/** Reads and decrypts one document's vectors in ordinal order, for a paged scan. */
export async function readChunkVectorsForDocument(docId: string): Promise<VectorRow[]> {
  const rows = await db.chunks.where('docId').equals(docId).toArray()
  rows.sort((a, b) => a.ordinal - b.ordinal)
  return Promise.all(rows.map(decryptRowVector))
}

export interface DocumentChunkText {
  id: string
  ordinal: number
  text: string
}

/** Reads one document's chunk texts in ordinal order, for a re-index. */
export async function readDocumentChunkTexts(docId: string): Promise<DocumentChunkText[]> {
  const rows = await db.chunks.where('docId').equals(docId).toArray()
  rows.sort((a, b) => a.ordinal - b.ordinal)
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      ordinal: row.ordinal,
      text: await decryptRecord(row.text, chunkTextSeed(row.id)),
    })),
  )
}

export interface ChunkRef {
  id: string
  docId: string
  dims: number
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('The index operation was aborted.')
  error.name = 'AbortError'
  return error
}

/**
 * Plaintext chunk references (id, docId, dims) collected with a cursor, so the
 * encrypted vector blobs are never accumulated: each row is discarded after its
 * three plaintext fields are read.
 */
export async function listChunkRefs(signal?: AbortSignal): Promise<ChunkRef[]> {
  const refs: ChunkRef[] = []
  await db.chunks.toCollection().each((row) => {
    if (signal?.aborted) throw abortError(signal.reason)
    refs.push({ id: row.id, docId: row.docId, dims: row.dims })
  })
  return refs
}

/** The dimension recorded on any chunk, used to size the index before a decrypt pass. */
export async function getFirstChunkDims(): Promise<number | null> {
  const row = await db.chunks.toCollection().first()
  return row?.dims ?? null
}

/**
 * Streams every chunk vector through `handler` in bounded batches. The cursor
 * never retains more than one batch of rows, so hydration is decrypted in a
 * bounded working set rather than materializing the whole table.
 */
export async function forEachChunkVector(
  handler: (row: VectorRow, index: number) => void,
  options: { signal?: AbortSignal; batchSize?: number } = {},
): Promise<void> {
  const batchSize = options.batchSize ?? 256
  let batch: ChunkRecord[] = []
  let index = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const rows = batch
    batch = []
    const decrypted = await Promise.all(rows.map(decryptRowVector))
    for (const row of decrypted) handler(row, index++)
  }
  await db.chunks.toCollection().each(async (row) => {
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    batch.push(row)
    if (batch.length >= batchSize) await flush()
  })
  await flush()
}

export async function getChunkText(id: string): Promise<string | null> {
  const row = await db.chunks.get(id)
  if (!row) return null
  return decryptRecord(row.text, chunkTextSeed(id))
}

/** Plaintext locating fields of a chunk, read without decrypting its blobs. */
export async function getChunkInfo(id: string): Promise<{ docId: string; ordinal: number } | null> {
  const row = await db.chunks.get(id)
  if (!row) return null
  return { docId: row.docId, ordinal: row.ordinal }
}

/** Every chunk row. Orphans are excluded by `sweepOrphanChunks` before use. */
export async function countChunks(): Promise<number> {
  return db.chunks.count()
}

/**
 * Deletes chunks whose `docId` has no document row. The repair path for a crash
 * or a quota failure that outran the atomic write. Returns how many it removed.
 */
export async function sweepOrphanChunks(): Promise<number> {
  const docIds = new Set((await db.documents.toCollection().primaryKeys()) as string[])
  const orphans: string[] = []
  await db.chunks.toCollection().each((row) => {
    if (!docIds.has(row.docId)) orphans.push(row.id)
  })
  if (orphans.length > 0) {
    await guardedWrite(async () => {
      await db.chunks.bulkDelete(orphans)
    })
  }
  return orphans.length
}
