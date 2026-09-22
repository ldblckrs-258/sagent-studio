import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockEmbeddingModelV4 } from 'ai/test'
import type { EmbeddingModel } from 'ai'
import { db } from '../vault/db'
import { deriveKey, randomBytes } from '../vault/crypto'
import { vaultInternals } from '../vault/store'
import * as keyring from '../vault/keyring'
import { EmbeddingProbeError } from '../ai/embedder'
import {
  ingestDocument,
  ingestFiles,
  kindOfFile,
  MAX_FILE_BYTES,
  type IngestFile,
} from './ingest'
import { countChunks, listChunkIds, listDocuments } from './store'
import type { IngestProgress } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function resetVault(): Promise<void> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-ingest-password', KDF))
}

function fileOf(name: string, content: string, type?: string): IngestFile {
  const bytes = new TextEncoder().encode(content)
  return {
    name,
    size: bytes.byteLength,
    type,
    text: async () => content,
    arrayBuffer: async () => bytes.buffer,
  }
}

function paragraphText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) =>
    `Paragraph ${i + 1} padding words so the tokenizer produces a real passage worth embedding.`,
  ).join('\n\n')
}

function vectorFor(index: number, dims = 4): number[] {
  return Array.from({ length: dims }, (_, axis) => (axis === 0 ? index + 1 : axis / 10))
}

function workingModel(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'embed',
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((_, index) => vectorFor(index)),
      usage: { tokens: values.length },
      warnings: [],
    }),
  })
}

function probeOnlyModel(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'embed',
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => {
      if (values.length !== 1) throw new Error('embedding model unavailable mid-batch')
      return { embeddings: [vectorFor(0)], usage: { tokens: 1 }, warnings: [] }
    },
  })
}

const baseIngest = {
  chunkSize: 128,
  overlap: 16,
  embedProviderId: 'p1',
  embedModel: 'embed',
} as const

describe('ingestDocument', () => {
  beforeEach(resetVault)

  it('chunks, embeds, encrypts, and persists a document', async () => {
    const result = await ingestDocument({
      ...baseIngest,
      file: fileOf('notes.txt', paragraphText(30), 'text/plain'),
      embedder: workingModel() as unknown as EmbeddingModel,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chunkCount).toBeGreaterThan(0)

    const listed = await listDocuments()
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(result.id)
    expect(listed[0].chunkCount).toBe(result.chunkCount)
    expect(await countChunks()).toBe(result.chunkCount)
  })

  it('emits progress phases in order', async () => {
    const phases: IngestProgress['phase'][] = []
    await ingestDocument({
      ...baseIngest,
      file: fileOf('notes.md', paragraphText(30), 'text/markdown'),
      embedder: workingModel() as unknown as EmbeddingModel,
      onProgress: (progress) => phases.push(progress.phase),
    })
    expect(phases[0]).toBe('extracting')
    expect(phases.at(-1)).toBe('persisting')
    expect(phases.indexOf('chunking')).toBeGreaterThan(phases.indexOf('extracting'))
    expect(phases.indexOf('embedding')).toBeGreaterThan(phases.indexOf('chunking'))
    expect(phases.indexOf('persisting')).toBeGreaterThanOrEqual(phases.indexOf('embedding'))
  })

  it('persists across a reopen of the table', async () => {
    const result = await ingestDocument({
      ...baseIngest,
      file: fileOf('notes.txt', paragraphText(10)),
      embedder: workingModel() as unknown as EmbeddingModel,
    })
    expect(result.ok).toBe(true)

    db.close()
    await db.open()
    const listed = await listDocuments()
    expect(listed.map((doc) => doc.sourceName)).toEqual(['notes.txt'])
  })

  it('leaves no rows when a write fails inside the transaction', async () => {
    const putSpy = vi
      .spyOn(db.documents, 'put')
      .mockRejectedValueOnce(new Error('disk full during write'))
    await expect(
      ingestDocument({
        ...baseIngest,
        file: fileOf('notes.txt', paragraphText(10)),
        embedder: workingModel() as unknown as EmbeddingModel,
      }),
    ).rejects.toThrow('disk full during write')
    putSpy.mockRestore()

    expect(await listDocuments()).toHaveLength(0)
    expect(await countChunks()).toBe(0)
  })

  it('replaces a document re-ingested under the same id', async () => {
    const first = await ingestDocument({
      ...baseIngest,
      id: 'fixed-doc',
      file: fileOf('notes.txt', paragraphText(30)),
      embedder: workingModel() as unknown as EmbeddingModel,
    })
    expect(first.ok).toBe(true)
    const firstIds = await listChunkIds()
    expect(firstIds.length).toBeGreaterThan(1)

    const second = await ingestDocument({
      ...baseIngest,
      id: 'fixed-doc',
      file: fileOf('notes.txt', paragraphText(12)),
      embedder: workingModel() as unknown as EmbeddingModel,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const secondIds = await listChunkIds()
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false)
    expect(secondIds).toHaveLength(second.chunkCount)
    expect(await countChunks()).toBe(second.chunkCount)
    expect(await listDocuments()).toHaveLength(1)
  })

  it('rejects a file over the size cap before reading it', async () => {
    const readText = vi.fn(async () => 'never')
    const readBytes = vi.fn(async () => new ArrayBuffer(0))
    const big: IngestFile = {
      name: 'huge.pdf',
      size: MAX_FILE_BYTES + 1,
      type: 'application/pdf',
      text: readText,
      arrayBuffer: readBytes,
    }
    await expect(
      ingestDocument({ ...baseIngest, file: big, embedder: workingModel() as unknown as EmbeddingModel }),
    ).rejects.toThrow(/MiB limit/)
    expect(readText).not.toHaveBeenCalled()
    expect(readBytes).not.toHaveBeenCalled()
  })
})

describe('kindOfFile', () => {
  it('maps pdf, markdown, and text by name and type', () => {
    expect(kindOfFile({ name: 'a.pdf' })).toBe('pdf')
    expect(kindOfFile({ name: 'a.bin', type: 'application/pdf' })).toBe('pdf')
    expect(kindOfFile({ name: 'a.md' })).toBe('markdown')
    expect(kindOfFile({ name: 'a.markdown' })).toBe('markdown')
    expect(kindOfFile({ name: 'a.txt' })).toBe('text')
  })
})

describe('ingestFiles', () => {
  beforeEach(resetVault)

  it('reports a failing file without aborting the batch', async () => {
    const failing: IngestFile = {
      name: 'broken.txt',
      size: 10,
      text: async () => {
        throw new Error('could not read file')
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }
    const results = await ingestFiles({
      ...baseIngest,
      files: [fileOf('good.txt', paragraphText(20)), failing],
      embedder: workingModel() as unknown as EmbeddingModel,
    })
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    if (!results[1].ok) expect(results[1].error).toContain('could not read file')
    const listed = await listDocuments()
    expect(listed.map((doc) => doc.sourceName)).toEqual(['good.txt'])
  })

  it('runs the probe first and leaves no rows when embedding fails', async () => {
    await expect(
      ingestFiles({
        ...baseIngest,
        files: [fileOf('a.txt', paragraphText(20)), fileOf('b.txt', paragraphText(20))],
        embedder: probeOnlyModel() as unknown as EmbeddingModel,
      }),
    ).resolves.toMatchObject([{ ok: false }, { ok: false }])
    expect(await listDocuments()).toHaveLength(0)
    expect(await countChunks()).toBe(0)
  })

  it('fails the probe with a named error when the provider serves no embedding model', async () => {
    const dead = new MockEmbeddingModelV4({
      provider: 'test',
      modelId: 'embed',
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      doEmbed: async () => {
        throw new Error('no embedding endpoint')
      },
    })
    await expect(
      ingestFiles({
        ...baseIngest,
        embedProviderId: 'openai',
        embedModel: 'text-embedding-3-small',
        files: [fileOf('a.txt', paragraphText(5))],
        embedder: dead as unknown as EmbeddingModel,
      }),
    ).rejects.toBeInstanceOf(EmbeddingProbeError)
    expect(await listDocuments()).toHaveLength(0)
  })
})
