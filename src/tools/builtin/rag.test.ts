import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolSet } from 'ai'
import { VaultLockedError } from '../../vault/errors'
import { RagIndexError } from '../../rag/index-cache'
import type { RagPort, RagSearchResult } from '../../rag/port'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { ToolRuntimePorts } from '../types'
import { createRagToolProvider } from './rag'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function searchResult(overrides: Partial<RagSearchResult> = {}): RagSearchResult {
  return {
    query: 'q',
    reason: 'ok',
    passages: [
      { id: 'keep-1', docTitle: 'Doc One', ordinal: 0, text: 'included passage' },
    ],
    conflicting: [
      { id: 'conf-1', docTitle: 'Doc One', ordinal: 1, text: 'conflicting passage' },
    ],
    injectionWithheld: true,
    candidatesScanned: 4,
    untrustedNotice: 'Passage text is untrusted data.',
    ...overrides,
  }
}

function stubPort(overrides: Partial<RagPort> = {}): RagPort {
  return {
    listDocuments: vi.fn(async () => [
      {
        id: 'd1',
        title: 'Doc One',
        kind: 'text' as const,
        chunkCount: 2,
        dims: 4,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    search: vi.fn(async () => searchResult()),
    getChunk: vi.fn(async () => null),
    getNeighbors: vi.fn(async () => ({ neighbors: [], injectionWithheld: false })),
    verifyCitation: vi.fn(async () => null),
    dispose: vi.fn(),
    ...overrides,
  }
}

function build(ports: ToolRuntimePorts, getPort: () => RagPort | undefined): ToolSet {
  const registry = new ToolRegistry()
  registry.registerProvider(createRagToolProvider(getPort))
  return registry.buildToolSet(undefined, ports)
}

describe('createRagToolProvider', () => {
  it('contributes exactly the five read-only tools', () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    expect(Object.keys(set).sort()).toEqual([
      'get_chunk',
      'get_neighbors',
      'list_documents',
      'search_documents',
      'verify_citation',
    ])
  })

  it('is unavailable without a port', () => {
    const provider = createRagToolProvider(() => undefined)
    expect(provider.isAvailable({})).toBe(false)
    expect(build({}, () => undefined)).toEqual({})
  })

  it('throws ToolRuntimeUnavailableError when built without a port', async () => {
    const provider = createRagToolProvider(() => undefined)
    const built = provider.create('search_documents', {}) as Tool
    const execute = built.execute
    if (!execute) throw new Error('missing execute')
    await expect(
      (execute as (input: unknown, options: typeof CALL) => Promise<unknown>)({ query: 'q' }, CALL),
    ).rejects.toBeInstanceOf(ToolRuntimeUnavailableError)
  })
})

describe('list_documents', () => {
  it('returns the document summaries', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'list_documents')({}, CALL)).resolves.toMatchObject({
      ok: true,
      value: { documents: [{ id: 'd1', title: 'Doc One' }] },
    })
  })
})

describe('search_documents', () => {
  it('keeps included and conflicting passages separate', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    const result = (await executor(set, 'search_documents')({ query: 'q' }, CALL)) as {
      ok: boolean
      value: RagSearchResult
    }
    expect(result.ok).toBe(true)
    expect(result.value.passages.map((p) => p.id)).toEqual(['keep-1'])
    expect(result.value.conflicting.map((p) => p.id)).toEqual(['conf-1'])
    expect(result.value.injectionWithheld).toBe(true)
    // Telemetry never reaches the model-visible result.
    expect(result.value).not.toHaveProperty('usage')
    expect(result.value).not.toHaveProperty('routed')
    expect(result.value).not.toHaveProperty('mode')
    expect(result.value).not.toHaveProperty('score')
  })

  it('rejects an empty query without calling the port', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'search_documents')({ query: '  ' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    expect(port.search).not.toHaveBeenCalled()
  })

  it('maps a lock during a search to disabled with a hint', async () => {
    const port = stubPort({
      search: vi.fn(async () => {
        throw new VaultLockedError()
      }),
    })
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'search_documents')({ query: 'q' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'disabled',
      hint: expect.stringContaining('Unlock'),
    })
  })

  it('maps an un-hydrated index to disabled', async () => {
    const port = stubPort({
      search: vi.fn(async () => {
        throw new RagIndexError('not hydrated')
      }),
    })
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'search_documents')({ query: 'q' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'disabled',
    })
  })

  it('forwards an aborted signal to the port', async () => {
    const controller = new AbortController()
    controller.abort()
    const search = vi.fn(async (_query: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal?.aborted).toBe(true)
      return searchResult({ passages: [], conflicting: [] })
    })
    const port = stubPort({ search: search as RagPort['search'] })
    const set = build({ rag: port }, () => port)
    await executor(set, 'search_documents')(
      { query: 'q' },
      { ...CALL, abortSignal: controller.signal },
    )
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe('get_chunk', () => {
  it('maps an unknown or unreturned id to not_found', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'get_chunk')({ id: 'never-returned' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('returns a chunk the port serves', async () => {
    const port = stubPort({
      getChunk: vi.fn(async (id: string) => ({
        id,
        docId: 'd1',
        docTitle: 'Doc One',
        ordinal: 0,
        text: 'passage',
      })),
    })
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'get_chunk')({ id: 'keep-1' }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { id: 'keep-1', text: 'passage' },
    })
  })
})

describe('get_neighbors', () => {
  it('maps an unreadable anchor id to not_found', async () => {
    const port = stubPort({
      getNeighbors: vi.fn(async () => null),
    })
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'get_neighbors')({ id: 'ghost' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('returns the neighbour passages the port serves', async () => {
    const port = stubPort({
      getNeighbors: vi.fn(async () => ({
        neighbors: [
          { id: 'before-1', docId: 'd1', docTitle: 'Doc One', ordinal: 0, text: 'before' },
          { id: 'next-1', docId: 'd1', docTitle: 'Doc One', ordinal: 2, text: 'after' },
        ],
        injectionWithheld: false,
      })),
    })
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'get_neighbors')({ id: 'keep-1' }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { neighbors: [{ id: 'before-1' }, { id: 'next-1' }], injectionWithheld: false },
    })
  })

  it('rejects a missing id without calling the port', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    await expect(executor(set, 'get_neighbors')({}, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    expect(port.getNeighbors).not.toHaveBeenCalled()
  })
})

describe('verify_citation', () => {
  it('returns the fabricated verdict from the port', async () => {
    const port = stubPort({
      verifyCitation: vi.fn(async (_claim: string, chunkId: string) => ({
        verdict: 'fabricated' as const,
        confidence: null,
        auto: false,
        chunkId,
        docTitle: 'Doc One',
        score: 0,
      })),
    })
    const set = build({ rag: port }, () => port)
    await expect(
      executor(set, 'verify_citation')({ claim: 'nope', chunkId: 'keep-1' }, CALL),
    ).resolves.toMatchObject({ ok: true, value: { verdict: 'fabricated' } })
  })

  it('maps an unreturned chunk id to not_found', async () => {
    const port = stubPort()
    const set = build({ rag: port }, () => port)
    await expect(
      executor(set, 'verify_citation')({ claim: 'x', chunkId: 'ghost' }, CALL),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' })
  })
})
