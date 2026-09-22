import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../vault/db'
import { deriveKey, randomBytes } from '../vault/crypto'
import { VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { useVaultStore, vaultInternals } from '../vault/store'
import {
  countChunks,
  deleteDocument,
  getChunkRecord,
  getChunkText,
  getDocument,
  listChunkIds,
  listDocuments,
  putDocumentAndChunks,
  sweepOrphanChunks,
} from './store'
import type { DocumentMeta, StoredChunk } from './types'

const MARKER = 'SEEDED_PLAINTEXT_MARKER_9f3c1a'
const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function resetVault(): Promise<void> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-store-password', KDF))
}

function meta(id: string, overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id,
    title: 'Notes',
    kind: 'text',
    sourceName: 'notes.txt',
    byteSize: 128,
    chunkCount: 1,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
    dims: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function chunk(id: string, docId: string, text = MARKER, vector = [0.5, -1.25, 2]): StoredChunk {
  return { id, docId, ordinal: 0, dims: vector.length, text, vector: Float32Array.from(vector) }
}

describe('rag store', () => {
  beforeEach(resetVault)

  it('round-trips chunk text and vector bit-exactly', async () => {
    const rows = [chunk('c1', 'd1'), chunk('c2', 'd1', 'second', [1, 2, 3, 4])]
    await putDocumentAndChunks(meta('d1', { chunkCount: 2, dims: 3 }), rows)

    const first = await getChunkRecord('c1')
    expect(first?.text).toBe(MARKER)
    expect(Array.from(first!.vector)).toEqual([0.5, -1.25, 2])
    expect(first?.dims).toBe(3)

    const second = await getChunkRecord('c2')
    expect(Array.from(second!.vector)).toEqual([1, 2, 3, 4])
    expect(await getChunkText('c1')).toBe(MARKER)
    expect(await countChunks()).toBe(2)
  })

  it('stores no plaintext content or vector in the raw row', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    const docRow = await db.documents.get('d1')
    const chunkRow = await db.chunks.get('c1')
    expect(JSON.stringify(docRow)).not.toContain(MARKER)
    expect(JSON.stringify(chunkRow)).not.toContain(MARKER)
    expect(JSON.stringify(chunkRow)).not.toContain('0.5')
    // The only plaintext per-chunk fields are ids, ordinal, dims, and timestamps.
    expect(chunkRow).toMatchObject({ id: 'c1', docId: 'd1', ordinal: 0, dims: 3 })
    expect(chunkRow!.vector).toMatchObject({ iv: expect.anything(), ciphertext: expect.anything() })
  })

  it('lists, reads, and deletes documents', async () => {
    await putDocumentAndChunks(meta('d1', { title: 'Alpha' }), [chunk('c1', 'd1')])
    await putDocumentAndChunks(meta('d2', { title: 'Beta' }), [chunk('c2', 'd2')])

    const listed = await listDocuments()
    expect(listed.map((doc) => doc.title).sort()).toEqual(['Alpha', 'Beta'])
    expect((await getDocument('d1'))?.title).toBe('Alpha')

    await deleteDocument('d1')
    expect(await getDocument('d1')).toBeNull()
    expect(await getChunkRecord('c1')).toBeNull()
    expect(await listChunkIds()).toEqual(['c2'])
  })

  it('joins chunk ids against documents and sweeps orphans', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    await db.chunks.put({
      id: 'orphan',
      docId: 'missing',
      ordinal: 0,
      dims: 1,
      text: { iv: new Uint8Array(12), ciphertext: new Uint8Array(4) },
      vector: { iv: new Uint8Array(12), ciphertext: new Uint8Array(4) },
      updatedAt: 1,
    })

    expect(await listChunkIds()).toEqual(['c1'])
    expect(await sweepOrphanChunks()).toBe(1)
    expect(await db.chunks.get('orphan')).toBeUndefined()
    expect(await db.chunks.get('c1')).toBeDefined()
  })

  it('throws VaultLockedError on every read path once the keyring is cleared', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    keyring.clear()

    await expect(listDocuments()).rejects.toBeInstanceOf(VaultLockedError)
    await expect(getDocument('d1')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(getChunkRecord('c1')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(getChunkText('c1')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('refuses a write once the keyring is cleared', async () => {
    keyring.clear()
    await expect(putDocumentAndChunks(meta('d1'), [])).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('rejects a write whose keyring locks mid-flight', async () => {
    const pending = putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    keyring.clear()
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    expect(await db.documents.count()).toBe(0)
    expect(await db.chunks.count()).toBe(0)
  })

  it('cannot decrypt a stored vector under a different key', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    keyring.install(await deriveKey('a-different-password', KDF))
    await expect(getChunkRecord('c1')).rejects.toThrow()
    await expect(getChunkText('c1')).rejects.toThrow()
  })

  it('replace semantics drop the previous chunks for the same document id', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('old-1', 'd1'), chunk('old-2', 'd1')])
    await putDocumentAndChunks(meta('d1'), [chunk('new-1', 'd1')])
    expect(await db.chunks.get('old-1')).toBeUndefined()
    expect(await db.chunks.get('old-2')).toBeUndefined()
    expect(await listChunkIds()).toEqual(['new-1'])
  })

  it('reset clears the document and chunk tables', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    await vaultInternals.reset()
    expect(await db.documents.count()).toBe(0)
    expect(await db.chunks.count()).toBe(0)
  })

  it('recover clears the document and chunk tables', async () => {
    await putDocumentAndChunks(meta('d1'), [chunk('c1', 'd1')])
    await useVaultStore.getState().recover()
    expect(await db.documents.count()).toBe(0)
    expect(await db.chunks.count()).toBe(0)
  })
})
