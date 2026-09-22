import { cosineSimilarity } from 'ai'
import { useVaultStore } from '../vault/store'
import {
  countChunks,
  forEachChunkVector,
  getFirstChunkDims,
  listChunkRefs,
  readChunkVectorsForDocument,
  sweepOrphanChunks,
} from './store'


export class RagIndexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RagIndexError'
  }
}

/**
 * The byte budget that decides resident vs paged mode and bounds the paged
 * document cache. 128 MiB holds ~50k chunks at 384 dims; at 1536 dims the index
 * pages instead of assuming residency.
 */
export function resolveVectorMemoryBudget(): number {
  const configured = Number(
    (import.meta.env?.VITE_RAG_VECTOR_MEMORY_BUDGET_BYTES as string | undefined) ?? NaN,
  )
  return Number.isFinite(configured) && configured > 0 ? configured : 128 * 1024 * 1024
}

export const RAG_VECTOR_MEMORY_BUDGET_BYTES = resolveVectorMemoryBudget()

export type RagIndexMode = 'resident' | 'paged' | 'none'

export interface VectorEntry {
  id: string
  docId: string
  dims: number
  vector: Float32Array
}

interface ClearedState {
  mode: 'none'
  generation: number
  dims: number
  ids: string[]
}

interface ResidentState {
  mode: 'resident'
  generation: number
  dims: number
  ids: string[]
  offsets: Map<string, number>
  docOf: Map<string, string>
  buffer: Float32Array
}

interface PagedDocument {
  ids: string[]
  data: Float32Array
}

interface PagedState {
  mode: 'paged'
  generation: number
  dims: number
  ids: string[]
  docOf: Map<string, string>
  docMembers: Map<string, string[]>
  cache: Map<string, PagedDocument>
  cacheBytes: number
}

type RagIndexState = ClearedState | ResidentState | PagedState

let state: RagIndexState = { mode: 'none', generation: -1, dims: 0, ids: [] }

function cleared(): ClearedState {
  return { mode: 'none', generation: -1, dims: 0, ids: [] }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('The index operation was aborted.')
  error.name = 'AbortError'
  return error
}

function currentGeneration(): number {
  return useVaultStore.getState().unlockGeneration
}

/** Throws when nothing is hydrated or the stamped unlock generation has moved. */
export function requireIndex(): void {
  if (state.mode === 'none') throw new RagIndexError('The document index is not hydrated.')
  if (state.generation !== currentGeneration()) {
    throw new RagIndexError('The document index belongs to a stale unlock generation.')
  }
}

export function isHydrated(): boolean {
  return state.mode !== 'none' && state.generation === currentGeneration()
}

export function mode(): RagIndexMode {
  return state.mode
}

export function entryCount(): number {
  return state.ids.length
}

export function indexDims(): number {
  return state.dims
}

export function clear(): void {
  state = cleared()
}

function emptyResident(generation: number): ResidentState {
  return {
    mode: 'resident',
    generation,
    dims: 0,
    ids: [],
    offsets: new Map(),
    docOf: new Map(),
    buffer: new Float32Array(0),
  }
}

export interface HydrateOptions {
  onProgress?: (progress: { done: number; total: number }) => void
  signal?: AbortSignal
}

/**
 * Builds the in-memory index from the encrypted rows. Sweeps orphans first,
 * chooses resident vs paged from the vectors' total byte cost, validates every
 * vector against its `ChunkRecord.dims`, and stamps the unlock generation. The
 * index is only committed on success, so an aborted call leaves the previous
 * index intact and writes no partial entries.
 */
export async function hydrate(options: HydrateOptions = {}): Promise<void> {
  const { onProgress, signal } = options
  await sweepOrphanChunks()
  const generation = currentGeneration()
  if (signal?.aborted) throw abortError(signal.reason)

  const total = await countChunks()
  if (total === 0) {
    state = emptyResident(generation)
    onProgress?.({ done: 0, total: 0 })
    return
  }

  const dims = await getFirstChunkDims()
  if (dims === null) {
    state = emptyResident(generation)
    onProgress?.({ done: 0, total: 0 })
    return
  }

  const totalBytes = total * dims * 4
  if (totalBytes <= resolveVectorMemoryBudget()) {
    await hydrateResident(total, dims, generation, onProgress, signal)
  } else {
    await hydratePaged(dims, generation, onProgress, signal)
  }
}

async function hydrateResident(
  total: number,
  dims: number,
  generation: number,
  onProgress: HydrateOptions['onProgress'],
  signal?: AbortSignal,
): Promise<void> {
  const buffer = new Float32Array(total * dims)
  const offsets = new Map<string, number>()
  const docOf = new Map<string, string>()
  const ids: string[] = []
  const REPORT_EVERY = 5000
  await forEachChunkVector(
    (row, index) => {
      if (row.dims !== dims) {
        throw new RagIndexError('A stored vector does not match its recorded dimension.')
      }
      buffer.set(row.vector, index * dims)
      offsets.set(row.id, index)
      docOf.set(row.id, row.docId)
      ids.push(row.id)
      if ((index + 1) % REPORT_EVERY === 0) onProgress?.({ done: index + 1, total })
    },
    { signal },
  )
  if (ids.length !== total) {
    throw new RagIndexError('The chunk set changed while the index was hydrating.')
  }
  onProgress?.({ done: total, total })
  if (currentGeneration() !== generation) {
    throw new RagIndexError('The vault was locked while the index was hydrating.')
  }
  state = { mode: 'resident', generation, dims, ids, offsets, docOf, buffer }
}

async function hydratePaged(
  dims: number,
  generation: number,
  onProgress: HydrateOptions['onProgress'],
  signal?: AbortSignal,
): Promise<void> {
  // Only the plaintext locating fields are retained; the encrypted blobs are
  // discarded row by row, so paged hydration does not materialize the corpus.
  const refs = await listChunkRefs(signal)
  const docOf = new Map<string, string>()
  const docMembers = new Map<string, string[]>()
  for (const ref of refs) {
    if (ref.dims !== dims) {
      throw new RagIndexError('The stored vectors have inconsistent dimensions.')
    }
    docOf.set(ref.id, ref.docId)
    const members = docMembers.get(ref.docId)
    if (members) members.push(ref.id)
    else docMembers.set(ref.docId, [ref.id])
  }
  if (signal?.aborted) throw abortError(signal.reason)
  if (currentGeneration() !== generation) {
    throw new RagIndexError('The vault was locked while the index was hydrating.')
  }
  onProgress?.({ done: refs.length, total: refs.length })
  state = { mode: 'paged', generation, dims, ids: refs.map((ref) => ref.id), docOf, docMembers, cache: new Map(), cacheBytes: 0 }
}

function cacheBudget(): number {
  return resolveVectorMemoryBudget()
}

function dropDocumentCache(paged: PagedState, docId: string): void {
  const cached = paged.cache.get(docId)
  if (!cached) return
  paged.cacheBytes -= cached.data.byteLength
  paged.cache.delete(docId)
}

async function loadDocument(paged: PagedState, docId: string): Promise<PagedDocument | null> {
  const cached = paged.cache.get(docId)
  if (cached) {
    paged.cache.delete(docId)
    paged.cache.set(docId, cached)
    return cached
  }
  const members = paged.docMembers.get(docId)
  if (!members || members.length === 0) return null
  const rows = await readChunkVectorsForDocument(docId)
  const data = new Float32Array(rows.length * paged.dims)
  rows.forEach((row, index) => {
    if (row.dims !== paged.dims) {
      throw new RagIndexError('A stored vector does not match its recorded dimension.')
    }
    data.set(row.vector, index * paged.dims)
  })
  const entry: PagedDocument = { ids: rows.map((row) => row.id), data }
  paged.cache.set(docId, entry)
  paged.cacheBytes += data.byteLength
  // Evict least-recently-used documents until the cache fits the budget.
  while (paged.cacheBytes > cacheBudget() && paged.cache.size > 1) {
    const oldest = paged.cache.keys().next().value
    if (oldest === undefined) break
    dropDocumentCache(paged, oldest)
  }
  return entry
}

/** The decrypted vector for a chunk, loading its document in paged mode. */
export async function getVector(id: string): Promise<Float32Array | null> {
  requireIndex()
  if (state.mode === 'resident') {
    const row = state.offsets.get(id)
    if (row === undefined) return null
    return state.buffer.slice(row * state.dims, (row + 1) * state.dims)
  }
  const paged = state as PagedState
  const docId = paged.docOf.get(id)
  if (docId === undefined) return null
  const doc = await loadDocument(paged, docId)
  if (!doc) return null
  const index = doc.ids.indexOf(id)
  if (index < 0) return null
  return doc.data.slice(index * paged.dims, (index + 1) * paged.dims)
}

export interface CosineHit {
  id: string
  score: number
}

export interface CosineResult {
  hits: CosineHit[]
  mode: RagIndexMode
  dims: number
}

function scoreVectors(hits: CosineHit[], ids: string[], data: Float32Array, dims: number, query: number[]): void {
  for (let row = 0; row < ids.length; row++) {
    const vector = data.subarray(row * dims, (row + 1) * dims) as unknown as number[]
    hits.push({ id: ids[row], score: cosineSimilarity(query, vector) })
  }
}

/**
 * Exact top-k cosine scan. `query` is compared against every indexed vector, in
 * resident mode over the contiguous buffer and in paged mode document by
 * document, keeping only the running top-k. Reports the mode it used.
 */
export async function cosineTopK(query: number[], k: number): Promise<CosineResult> {
  requireIndex()
  const dims = state.dims
  if (query.length !== dims) {
    throw new RagIndexError(
      `Query dimension ${query.length} does not match the index dimension ${dims}.`,
    )
  }
  const limit = Math.max(1, Math.min(Math.trunc(k), state.ids.length))
  if (state.ids.length === 0) return { hits: [], mode: state.mode, dims }

  const hits: CosineHit[] = []
  if (state.mode === 'resident') {
    scoreVectors(hits, state.ids, state.buffer, dims, query)
  } else {
    const paged = state as PagedState
    for (const docId of paged.docMembers.keys()) {
      const doc = await loadDocument(paged, docId)
      if (!doc) continue
      for (let row = 0; row < doc.ids.length; row++) {
        const vector = doc.data.subarray(row * dims, (row + 1) * dims) as unknown as number[]
        let score: number
        try {
          score = cosineSimilarity(query, vector)
        } catch (cause) {
          throw new RagIndexError('The cosine scan received mismatched vector dimensions.', { cause })
        }
        if (!Number.isFinite(score)) {
          throw new RagIndexError('The cosine scan produced a non-finite score.')
        }
        hits.push({ id: doc.ids[row], score })
      }
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, limit), mode: state.mode, dims }
}

function collectResidentEntries(resident: ResidentState): Map<string, VectorEntry> {
  const entries = new Map<string, VectorEntry>()
  for (const id of resident.ids) {
    const row = resident.offsets.get(id)
    if (row === undefined) continue
    entries.set(id, {
      id,
      docId: resident.docOf.get(id) ?? '',
      dims: resident.dims,
      vector: resident.buffer.slice(row * resident.dims, (row + 1) * resident.dims),
    })
  }
  return entries
}

function bytesOf(entries: Iterable<VectorEntry>): number {
  let total = 0
  for (const entry of entries) total += entry.dims * 4
  return total
}

function buildResident(entries: Map<string, VectorEntry>, generation: number, dims: number): ResidentState {
  const ids = [...entries.keys()]
  const buffer = new Float32Array(ids.length * dims)
  const offsets = new Map<string, number>()
  const docOf = new Map<string, string>()
  ids.forEach((id, row) => {
    const entry = entries.get(id)!
    buffer.set(entry.vector, row * dims)
    offsets.set(id, row)
    docOf.set(id, entry.docId)
  })
  return { mode: 'resident', generation, dims, ids, offsets, docOf, buffer }
}

function buildPaged(entries: Map<string, VectorEntry>, generation: number, dims: number): PagedState {
  const docOf = new Map<string, string>()
  const docMembers = new Map<string, string[]>()
  for (const entry of entries.values()) {
    docOf.set(entry.id, entry.docId)
    const members = docMembers.get(entry.docId)
    if (members) members.push(entry.id)
    else docMembers.set(entry.docId, [entry.id])
  }
  return {
    mode: 'paged',
    generation,
    dims,
    ids: [...entries.keys()],
    docOf,
    docMembers,
    cache: new Map(),
    cacheBytes: 0,
  }
}

function rebuild(
  resident: ResidentState,
  add: readonly VectorEntry[],
  removeIds: ReadonlySet<string>,
  removeDocs: ReadonlySet<string>,
): void {
  const entries = collectResidentEntries(resident)
  for (const id of removeIds) entries.delete(id)
  if (removeDocs.size > 0) {
    for (const [id, entry] of entries) if (removeDocs.has(entry.docId)) entries.delete(id)
  }
  for (const entry of add) entries.set(entry.id, entry)
  const dims = resident.dims
  if (bytesOf(entries.values()) <= cacheBudget()) {
    state = buildResident(entries, resident.generation, dims)
  } else {
    state = buildPaged(entries, resident.generation, dims)
  }
}

function mutatePaged(
  paged: PagedState,
  add: readonly VectorEntry[],
  removeIds: ReadonlySet<string>,
  removeDocs: ReadonlySet<string>,
): void {
  const affectedDocs = new Set<string>()
  const ids = new Set(paged.ids)
  for (const id of removeIds) {
    const docId = paged.docOf.get(id)
    if (docId !== undefined) affectedDocs.add(docId)
    ids.delete(id)
  }
  for (const [id, entry] of paged.docOf) {
    if (removeDocs.has(entry)) {
      affectedDocs.add(entry)
      ids.delete(id)
    }
  }
  for (const entry of add) {
    ids.add(entry.id)
    if (paged.docOf.get(entry.id) !== entry.docId) affectedDocs.add(entry.docId)
    paged.docOf.set(entry.id, entry.docId)
  }
  for (const docId of affectedDocs) {
    dropDocumentCache(paged, docId)
    const members = paged.docMembers.get(docId)
    if (!members) continue
    const kept = members.filter((id) => ids.has(id) && paged.docOf.get(id) === docId)
    if (kept.length > 0) paged.docMembers.set(docId, kept)
    else paged.docMembers.delete(docId)
  }
  for (const entry of add) {
    const members = paged.docMembers.get(entry.docId) ?? []
    if (!members.includes(entry.id)) members.push(entry.id)
    paged.docMembers.set(entry.docId, members)
  }
  paged.ids = [...ids]
}

/** Inserts or replaces vectors on the live index; a no-op before hydration. */
export async function addVectors(entries: readonly VectorEntry[]): Promise<void> {
  if (state.mode === 'none') return
  requireIndex()
  if (entries.length === 0) return
  if (state.ids.length === 0) {
    const dims = entries[0].dims
    for (const entry of entries) {
      if (entry.dims !== dims) throw new RagIndexError('The new vectors have inconsistent dimensions.')
    }
    if (state.mode === 'resident') {
      state = buildResident(new Map(entries.map((entry) => [entry.id, entry])), state.generation, dims)
    } else {
      state.dims = dims
      mutatePaged(state, entries, new Set(), new Set())
    }
    return
  }
  for (const entry of entries) {
    if (entry.dims !== state.dims) {
      throw new RagIndexError(
        'The new vectors have a different dimension than the index; re-add the library after changing the embedding model.',
      )
    }
  }
  const add: VectorEntry[] = entries.map((entry) => ({
    id: entry.id,
    docId: entry.docId,
    dims: entry.dims,
    vector: entry.vector,
  }))
  if (state.mode === 'resident') rebuild(state, add, new Set(), new Set())
  else mutatePaged(state, add, new Set(), new Set())
}

/** Removes a set of chunk ids from the live index; a no-op before hydration. */
export async function removeVectors(ids: readonly string[]): Promise<void> {
  if (state.mode === 'none') return
  requireIndex()
  if (ids.length === 0) return
  const remove = new Set(ids)
  if (state.mode === 'resident') rebuild(state, [], remove, new Set())
  else mutatePaged(state, [], remove, new Set())
}

/** Evicts every vector belonging to a document; a no-op before hydration. */
export async function removeDocument(docId: string): Promise<void> {
  if (state.mode === 'none') return
  requireIndex()
  if (state.mode === 'resident') rebuild(state, [], new Set(), new Set([docId]))
  else mutatePaged(state, [], new Set(), new Set([docId]))
}
