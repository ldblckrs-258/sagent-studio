import { describe, expect, it, vi } from 'vitest'
import type { EmbeddingModel } from 'ai'
import { defaultSettings } from '../vault/settings'
import { createDocumentLibraryStore } from './library-state'
import type { DocumentLibraryDeps, IngestRequest } from './library-state'
import type { DocumentMeta, IngestProgress, IngestResult } from './types'

function meta(id: string, title = id): DocumentMeta {
  return {
    id,
    title,
    kind: 'text',
    sourceName: `${title}.txt`,
    byteSize: 1,
    chunkCount: 2,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
    dims: 4,
    createdAt: 1,
    updatedAt: 1,
  }
}

const FILE = { name: 'a.txt', size: 3, text: async () => 'abc', arrayBuffer: async () => new ArrayBuffer(0) }

function makeDeps(overrides: Partial<DocumentLibraryDeps> = {}): DocumentLibraryDeps {
  return {
    getSettings: () => defaultSettings(),
    list: vi.fn(async () => [] as DocumentMeta[]),
    remove: vi.fn(async () => {}),
    readVectors: vi.fn(async (docId: string) => [
      { id: `${docId}-c0`, docId, dims: 4, vector: Float32Array.from([1, 0, 0, 0]) },
    ]),
    readChunkTexts: vi.fn(async (docId: string) => [
      { id: `${docId}-c0`, ordinal: 0, text: 'chunk' },
    ]),
    replaceDocument: vi.fn(async () => {}),
    ingest: vi.fn(async () => [{ ok: true, id: 'new', title: 'a', kind: 'text', chunkCount: 1, dims: 4 }] as IngestResult[]),
    addVectors: vi.fn(async () => {}),
    removeVectorsForDocument: vi.fn(async () => {}),
    embedderFor: vi.fn(() => ({}) as EmbeddingModel),
    resolveProviderId: vi.fn(() => 'p1'),
    embedTexts: vi.fn(async (_embedder, texts: readonly string[]) => texts.map(() => [1, 0, 0, 0])),
    probe: vi.fn(async () => 4),
    clearIndex: vi.fn(),
    hydrateIndex: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('useDocumentLibraryStore', () => {
  it('drives ingest progress and adds vectors after a successful ingest', async () => {
    const deps = makeDeps()
    const statuses: string[] = []
    const store = createDocumentLibraryStore(deps)
    store.subscribe((state) => statuses.push(state.status))

    await store.getState().addFiles([FILE])

    expect(deps.ingest).toHaveBeenCalledTimes(1)
    const request = (deps.ingest as ReturnType<typeof vi.fn>).mock.calls[0][1] as IngestRequest
    expect(request.embedProviderId).toBe('p1')
    expect(request.chunkSize).toBe(defaultSettings().rag.chunkSize)
    request.onProgress?.({ phase: 'embedding', done: 1, total: 2 } as IngestProgress)

    expect(deps.readVectors).toHaveBeenCalledWith('new')
    expect(deps.addVectors).toHaveBeenCalledTimes(1)
    expect(store.getState().status).toBe('idle')
    expect(statuses).toContain('ingesting')
  })

  it('sets an error for a failing file without clearing the existing list', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => [meta('existing')]),
      ingest: vi.fn(async () => [{ ok: false, title: 'bad', kind: 'text', error: 'no embedding model' }] as IngestResult[]),
    })
    const store = createDocumentLibraryStore(deps)
    await store.getState().refresh()
    expect(store.getState().documents).toHaveLength(1)

    await store.getState().addFiles([FILE])
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toContain('no embedding model')
    // refresh ran and the list is unchanged, not emptied.
    expect(store.getState().documents.map((doc) => doc.id)).toEqual(['existing'])
    expect(deps.addVectors).not.toHaveBeenCalled()
  })

  it('surfaces a probe failure as a named error without adding rows', async () => {
    const deps = makeDeps({
      ingest: vi.fn(async () => {
        throw new Error('The embedding provider "p1" did not return an embedding.')
      }),
    })
    const store = createDocumentLibraryStore(deps)
    await store.getState().addFiles([FILE])
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toContain('p1')
  })

  it('removes a document and evicts its vectors with the same id', async () => {
    const deps = makeDeps({ list: vi.fn(async () => [meta('doc-1')]) })
    const store = createDocumentLibraryStore(deps)
    await store.getState().refresh()

    await store.getState().remove('doc-1')
    expect(deps.remove).toHaveBeenCalledWith('doc-1')
    expect(deps.removeVectorsForDocument).toHaveBeenCalledWith('doc-1')
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  it('re-embeds every document with the new model and rebuilds the index', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => [meta('doc-1')]),
      readChunkTexts: vi.fn(async (docId: string) => [
        { id: `${docId}-c0`, ordinal: 0, text: 'old chunk' },
      ]),
      embedTexts: vi.fn(async (_embedder, texts: readonly string[]) => texts.map(() => [1, 0, 0])),
    })
    const store = createDocumentLibraryStore(deps)
    await store.getState().reindex()

    expect(deps.embedTexts).toHaveBeenCalledTimes(1)
    expect(deps.replaceDocument).toHaveBeenCalledTimes(1)
    const [nextMeta] = (deps.replaceDocument as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { dims: number; embedModel: string },
    ]
    expect(nextMeta.dims).toBe(3)
    expect(nextMeta.embedModel).toBe(defaultSettings().rag.embedModel)
    expect(deps.clearIndex).toHaveBeenCalledTimes(1)
    expect(deps.hydrateIndex).toHaveBeenCalledTimes(1)
    expect(store.getState().status).toBe('idle')
  })

  it('re-indexes before ingesting when the stored dimensions differ from the current model', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => [meta('doc-1')]),
      probe: vi.fn(async () => 3),
      readChunkTexts: vi.fn(async (docId: string) => [
        { id: `${docId}-c0`, ordinal: 0, text: 'old chunk' },
      ]),
      embedTexts: vi.fn(async (_embedder, texts: readonly string[]) => texts.map(() => [1, 0, 0])),
    })
    const store = createDocumentLibraryStore(deps)
    await store.getState().addFiles([FILE])

    expect(deps.replaceDocument).toHaveBeenCalledTimes(1)
    expect(deps.clearIndex).toHaveBeenCalledTimes(1)
    expect(deps.hydrateIndex).toHaveBeenCalledTimes(1)
    expect(deps.ingest).toHaveBeenCalledTimes(1)
    expect(store.getState().status).toBe('idle')
  })

  it('does not re-index when the current model matches the stored dimensions', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => [meta('doc-1')]),
      probe: vi.fn(async () => 4),
    })
    const store = createDocumentLibraryStore(deps)
    await store.getState().addFiles([FILE])
    expect(deps.replaceDocument).not.toHaveBeenCalled()
    expect(deps.clearIndex).not.toHaveBeenCalled()
    expect(deps.ingest).toHaveBeenCalledTimes(1)
  })

  it('clear resets the list and status', async () => {
    const deps = makeDeps({ list: vi.fn(async () => [meta('doc-1')]) })
    const store = createDocumentLibraryStore(deps)
    await store.getState().refresh()
    store.setState({ error: 'boom', status: 'error', progress: { phase: 'embedding', done: 1, total: 2 } })

    store.getState().clear()
    expect(store.getState().documents).toEqual([])
    expect(store.getState().status).toBe('idle')
    expect(store.getState().error).toBeNull()
    expect(store.getState().progress).toBeNull()
  })
})
