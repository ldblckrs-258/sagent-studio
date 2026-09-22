import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cosineSimilarity } from 'ai'
import { deriveKey, randomBytes } from '../vault/crypto'
import * as keyring from '../vault/keyring'
import { useVaultStore, vaultInternals } from '../vault/store'
import { clear, entryCount, hydrate, mode, RagIndexError } from './index-cache'
import { cosineTopK, embedQuery } from './retrieval'
import { putDocumentAndChunks } from './store'
import type { DocumentMeta, StoredChunk } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function installVault(): Promise<void> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-retrieval-password', KDF))
  useVaultStore.setState({ status: 'unlocked', unlockGeneration: keyring.getGeneration() })
}

function bruteForce(query: number[], vectors: { id: string; vector: number[] }[]): { id: string; score: number }[] {
  return vectors
    .map((entry) => ({ id: entry.id, score: cosineSimilarity(query, entry.vector) }))
    .sort((a, b) => b.score - a.score)
}

async function seedChunks(docId: string, entries: { id: string; vector: number[] }[]): Promise<void> {
  const dims = entries[0].vector.length
  const chunks: StoredChunk[] = entries.map((entry, ordinal) => ({
    id: entry.id,
    docId,
    ordinal,
    dims,
    text: entry.id,
    vector: Float32Array.from(entry.vector),
  }))
  const meta: DocumentMeta = {
    id: docId,
    title: docId,
    kind: 'text',
    sourceName: `${docId}.txt`,
    byteSize: 1,
    chunkCount: chunks.length,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
    dims,
    createdAt: 1,
    updatedAt: 1,
  }
  await putDocumentAndChunks(meta, chunks)
}

describe('cosineTopK', () => {
  beforeEach(async () => {
    await installVault()
    clear()
  })

  it('matches a brute-force reference, sorted descending and respecting k', async () => {
    const entries = [
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0.9, 0.1, 0] },
      { id: 'c', vector: [0, 1, 0] },
      { id: 'd', vector: [0.2, 0.2, 0.2] },
    ]
    await seedChunks('doc', entries)
    await hydrate()

    const query = [1, 0.2, 0]
    const result = await cosineTopK(query, 2)
    const reference = bruteForce(query, entries).slice(0, 2)
    expect(result.hits.map((hit) => hit.id)).toEqual(reference.map((hit) => hit.id))
    // Float32 storage rounds the stored vector; compare to ~1e-6.
    expect(result.hits[0].score).toBeCloseTo(reference[0].score, 5)
    expect(result.mode).toBe('resident')
    expect(result.hits).toHaveLength(2)
  })

  it('treats a Float32Array cast the same as a number[] for cosineSimilarity', () => {
    const asArray = cosineSimilarity([1, 2, 3], [4, 5, 6])
    const cast = new Float32Array([1, 2, 3]) as unknown as number[]
    expect(cosineSimilarity(cast, [4, 5, 6])).toBeCloseTo(asArray, 12)
  })

  it('throws RagIndexError on a query dimension mismatch', async () => {
    await seedChunks('doc', [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0, 1] },
    ])
    await hydrate()
    await expect(cosineTopK([1, 0, 0], 1)).rejects.toBeInstanceOf(RagIndexError)
  })

  it('returns the same top-k ids and scores in paged mode', async () => {
    vi.stubEnv('VITE_RAG_VECTOR_MEMORY_BUDGET_BYTES', '4')
    try {
      const entries = [
        { id: 'a', vector: [1, 0] },
        { id: 'b', vector: [0, 1] },
      ]
      await seedChunks('doc', entries)
      await hydrate()
      expect(mode()).toBe('paged')
      const result = await cosineTopK([1, 0], 1)
      expect(result.mode).toBe('paged')
      expect(result.hits[0].id).toBe('a')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('embedQuery', () => {
  it('rejects an empty query before calling the provider', async () => {
    await expect(embedQuery({} as never, '   ')).rejects.toBeInstanceOf(RagIndexError)
  })
})

describe('target scale', () => {
  beforeEach(async () => {
    await installVault()
    clear()
  })

  it(
    'hydrates and scans 1,000 documents / 50,000 chunks within a generous ceiling',
    async () => {
      const DOCS = 1000
      const PER_DOC = 50
      const DIMS = 16
      const random = (seed: number): number[] =>
        Array.from({ length: DIMS }, (_, i) => Math.sin(seed * (i + 1)) * 0.5 + 0.5)

      for (let doc = 0; doc < DOCS; doc++) {
        const entries = Array.from({ length: PER_DOC }, (_, chunk) => ({
          id: `d${doc}-c${chunk}`,
          vector: random(doc * PER_DOC + chunk),
        }))
        await seedChunks(`d${doc}`, entries)
      }

      const start = performance.now()
      await hydrate()
      const hydrateMs = performance.now() - start
      expect(entryCount()).toBe(DOCS * PER_DOC)
      expect(mode()).toBe('resident')

      const query = random(123)
      const samples: number[] = []
      for (let run = 0; run < 5; run++) {
        const scanStart = performance.now()
        const result = await cosineTopK(query, 5)
        samples.push(performance.now() - scanStart)
        expect(result.hits).toHaveLength(5)
      }
      samples.sort((a, b) => a - b)
      const median = samples[Math.floor(samples.length / 2)]

      // Recorded in the phase report; the assertion is deliberately generous so
      // only an algorithmic regression fails.
      expect(median).toBeLessThan(500)
      expect(hydrateMs).toBeLessThan(120_000)
    },
    180_000,
  )
})
