import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../vault/db'
import { deriveKey, randomBytes } from '../vault/crypto'
import * as keyring from '../vault/keyring'
import { useVaultStore, vaultInternals } from '../vault/store'
import {
  addVectors,
  clear,
  cosineTopK,
  entryCount,
  getVector,
  hydrate,
  indexDims,
  isHydrated,
  mode,
  RagIndexError,
  removeDocument,
  removeVectors,
  requireIndex,
} from './index-cache'
import { putDocumentAndChunks } from './store'
import type { DocumentMeta, StoredChunk } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function installVault(): Promise<void> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-index-password', KDF))
  useVaultStore.setState({ status: 'unlocked', unlockGeneration: keyring.getGeneration() })
}

function meta(docId: string, overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: docId,
    title: docId,
    kind: 'text',
    sourceName: `${docId}.txt`,
    byteSize: 1,
    chunkCount: 1,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
    dims: 2,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function seed(docId: string, vectors: number[][]): Promise<string[]> {
  const dims = vectors[0].length
  const chunks: StoredChunk[] = vectors.map((vector, ordinal) => ({
    id: `${docId}-c${ordinal}`,
    docId,
    ordinal,
    dims,
    text: `chunk ${ordinal}`,
    vector: Float32Array.from(vector),
  }))
  await putDocumentAndChunks(meta(docId, { chunkCount: chunks.length, dims }), chunks)
  return chunks.map((chunk) => chunk.id)
}

describe('index-cache', () => {
  beforeEach(async () => {
    await installVault()
    clear()
  })

  it('hydrates one entry per chunk with matching vector values', async () => {
    const ids = await seed('d1', [
      [1, 0],
      [0, 1],
      [1, 1],
    ])
    await hydrate()
    expect(isHydrated()).toBe(true)
    expect(mode()).toBe('resident')
    expect(entryCount()).toBe(3)
    expect(Array.from((await getVector(ids[1]))!)).toEqual([0, 1])
  })

  it('sweeps an orphan chunk before hydrating', async () => {
    await seed('d1', [[1, 0]])
    await db.chunks.put({
      id: 'orphan',
      docId: 'missing',
      ordinal: 0,
      dims: 2,
      text: { iv: new Uint8Array(12), ciphertext: new Uint8Array(4) },
      vector: { iv: new Uint8Array(12), ciphertext: new Uint8Array(4) },
      updatedAt: 1,
    })
    await hydrate()
    expect(entryCount()).toBe(1)
    expect(await getVector('orphan')).toBeNull()
  })

  it('throws from every read once the generation is bumped by lock', async () => {
    const ids = await seed('d1', [[1, 0]])
    await hydrate()
    await useVaultStore.getState().lock()

    expect(() => requireIndex()).toThrow(RagIndexError)
    await expect(getVector(ids[0])).rejects.toBeInstanceOf(RagIndexError)
    await expect(cosineTopK([1, 0], 1)).rejects.toBeInstanceOf(RagIndexError)
    expect(isHydrated()).toBe(false)
  })

  it('clear empties the cache and is idempotent', async () => {
    await seed('d1', [[1, 0]])
    await hydrate()
    clear()
    expect(entryCount()).toBe(0)
    expect(mode()).toBe('none')
    clear()
    expect(mode()).toBe('none')
  })

  it('does not double-count on a second hydrate', async () => {
    const ids = await seed('d1', [
      [1, 0],
      [0, 1],
    ])
    await hydrate()
    await hydrate()
    expect(entryCount()).toBe(2)
    expect(await getVector(ids[0])).not.toBeNull()
  })

  it('throws when stored vectors have inconsistent dimensions', async () => {
    await seed('d1', [[1, 0]])
    await seed('d2', [[1, 0, 0]])
    await expect(hydrate()).rejects.toBeInstanceOf(RagIndexError)
  })

  it('leaves the previous index intact when a hydrate aborts', async () => {
    const ids = await seed('d1', [[1, 0]])
    await hydrate()
    await seed('d2', [
      [0, 1],
      [1, 1],
    ])

    const controller = new AbortController()
    controller.abort()
    await expect(hydrate({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(entryCount()).toBe(1)
    expect(Array.from((await getVector(ids[0]))!)).toEqual([1, 0])
  })

  it('mutators change entryCount and are no-ops before hydration', async () => {
    await addVectors([])
    expect(entryCount()).toBe(0)
    await removeVectors(['x'])
    expect(entryCount()).toBe(0)
    await removeDocument('d1')
    expect(entryCount()).toBe(0)

    await seed('d1', [[1, 0]])
    await hydrate()
    const extra: StoredChunk = {
      id: 'extra',
      docId: 'd1',
      ordinal: 9,
      dims: 2,
      text: 'extra',
      vector: Float32Array.from([0, 1]),
    }
    await addVectors([extra])
    expect(entryCount()).toBe(2)
    expect(Array.from((await getVector('extra'))!)).toEqual([0, 1])

    await removeVectors(['extra'])
    expect(entryCount()).toBe(1)

    await removeDocument('d1')
    expect(entryCount()).toBe(0)
  })

  it('adopts the embedding dimension on the first ingest into an empty index', async () => {
    await hydrate()
    expect(mode()).toBe('resident')
    await addVectors([
      { id: 'a', docId: 'd1', dims: 3, vector: Float32Array.from([1, 2, 3]) },
      { id: 'b', docId: 'd1', dims: 3, vector: Float32Array.from([3, 2, 1]) },
    ])
    expect(entryCount()).toBe(2)
    expect(indexDims()).toBe(3)
    expect(Array.from((await getVector('a'))!)).toEqual([1, 2, 3])
    const result = await cosineTopK([1, 2, 3], 1)
    expect(result.hits[0].id).toBe('a')
  })

  it('rejects addVectors whose dimension differs from the index', async () => {
    await seed('d1', [[1, 0]])
    await hydrate()
    await expect(
      addVectors([{ id: 'x', docId: 'd1', dims: 3, vector: Float32Array.from([0, 0, 1]) }]),
    ).rejects.toBeInstanceOf(RagIndexError)
    expect(entryCount()).toBe(1)
  })

  it('hydrates paged mode when the vectors exceed the budget', async () => {
    vi.stubEnv('VITE_RAG_VECTOR_MEMORY_BUDGET_BYTES', '4')
    try {
      const ids = await seed('d1', [
        [1, 0],
        [0, 1],
      ])
      await hydrate()
      expect(mode()).toBe('paged')
      expect(entryCount()).toBe(2)
      const result = await cosineTopK([1, 0], 2)
      expect(result.mode).toBe('paged')
      expect(result.hits[0].id).toBe(ids[0])
      expect(Array.from((await getVector(ids[1]))!)).toEqual([0, 1])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
