import type { EmbeddingModel, LanguageModel } from 'ai'
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import { createRagToolProvider } from '../tools/builtin/rag'
import { defaultSettings } from '../vault/settings'
import type { Settings } from '../vault/settings'
import { deriveKey, randomBytes } from '../vault/crypto'
import * as keyring from '../vault/keyring'
import { useVaultStore, vaultInternals } from '../vault/store'
import { createEngine } from '../chat/engine'
import type { EngineDeps, ThreadStore } from '../chat/engine'
import { useChatStore } from '../chat/store'
import { defaultThreadConfig } from '../chat/types'
import type { ChatThread } from '../chat/types'
import {
  BYPASS_CASES,
  CONTRADICTED_CLAIM,
  createAdversarialTypeSafe,
  FALSE_PREMISE_QUERY,
  FIXTURE_DOCUMENTS,
  HALLUCINATED_CLAIM,
  INJECTION_MARKER,
} from './adversarial-fixtures'
import { clear, hydrate } from './index-cache'
import { createRagPort } from './port'
import type { RagPort } from './port'
import { createJevCache, gradePair } from './jev'
import { noulAnswer, systemOneResult } from './fixtures'
import { ingestFiles, type IngestFile } from './ingest'
import type { TypeSafeClient } from '@typesafe-ai/sdk'

type Usage = {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
}

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; usage: Usage; finishReason: { unified: 'stop' | 'tool-calls'; raw: string | undefined } }

const usage: Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function toolStep(id: string, toolName: string, input: unknown): Chunk[] {
  const text = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: text },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: text },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
  ]
}

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ]
}

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function settings(): Settings {
  const base = defaultSettings()
  return {
    ...base,
    providers: [
      {
        id: 'p1',
        label: 'Local',
        kind: 'openai-compatible',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'provider-key',
        models: [{ id: 'llama3' }],
        defaultModel: 'llama3',
      },
    ],
    typesafe: { apiKey: 'typesafe-key', model: 'jev-latest' },
    rag: { ...base.rag, topK: 10, embedProviderId: 'p1', embedModel: 'embed' },
  }
}

function stubEmbedder(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'test',
    modelId: 'embed',
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [1, 0, 0, 0]),
      usage: { tokens: values.length },
      warnings: [],
    }),
  })
}

function fileOf(title: string, text: string): IngestFile {
  const bytes = new TextEncoder().encode(text)
  return {
    name: `${title}.txt`,
    size: bytes.byteLength,
    type: 'text/plain',
    text: async () => text,
    arrayBuffer: async () => bytes.buffer,
  }
}

function rewriteReply(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: text.length > 0 ? [{ type: 'text' as const, text }] : [],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  })
}

function memoryStore(): ThreadStore {
  const threads = new Map<string, ChatThread>()
  return {
    loadThread: async (id) => threads.get(id) ?? null,
    saveThread: async (thread) => {
      threads.set(thread.id, thread)
    },
    listThreads: async () => [],
    deleteThread: async (id) => {
      threads.delete(id)
    },
  }
}

async function setupPipeline(): Promise<{ port: RagPort; embedder: MockEmbeddingModelV4 }> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-e2e-password', KDF))
  const config = settings()
  useVaultStore.setState({
    status: 'unlocked',
    settings: config,
    unlockGeneration: keyring.getGeneration(),
  })
  clear()

  const embedder = stubEmbedder()
  const results = await ingestFiles({
    files: FIXTURE_DOCUMENTS.map((document) => fileOf(document.title, document.text)),
    embedder: embedder as unknown as EmbeddingModel,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
  })
  expect(results.every((result) => result.ok)).toBe(true)
  await hydrate()

  const port = createRagPort({
    getSettings: () => useVaultStore.getState().settings,
    embedderFor: () => embedder as unknown as EmbeddingModel,
    typesafe: createAdversarialTypeSafe(),
    cache: createJevCache(),
  })
  return { port, embedder }
}

beforeEach(() => {
  useChatStore.getState().clear()
})

describe('RAG end-to-end', () => {
  it('routes a false premise to conflicting_evidence and withholds the injection payload', async () => {
    const { port } = await setupPipeline()

    const registry = new ToolRegistry()
    registry.registerProvider(createRagToolProvider(() => port))
    const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'search_documents', { query: FALSE_PREMISE_QUERY })) },
        { stream: streamOf(textStep('t2', 'The documents contradict the premise.')) },
      ],
    })
    const deps: EngineDeps = {
      getSettings: () => useVaultStore.getState().settings,
      skillRegistry: new SkillRegistry(skillStore),
      toolRegistry: registry,
      threadStore: memoryStore(),
      rag: port,
      modelFactory: () => model as unknown as LanguageModel,
    }
    const engine = createEngine(deps)
    const thread: ChatThread = {
      id: 'th1',
      title: 'RAG',
      messages: [],
      config: defaultThreadConfig('p1', 'llama3'),
      mode: 'god',
      createdAt: 1,
      updatedAt: 1,
    }
    useChatStore.getState().setThread(thread)

    await engine.sendTurn('th1', FALSE_PREMISE_QUERY)

    const messages = useChatStore.getState().threads.th1.messages
    const toolParts = messages.flatMap((message) =>
      message.parts.filter((part) => part.type.startsWith('tool-')),
    ) as Array<{ output?: { ok?: boolean; value?: Record<string, unknown> } }>
    const value = toolParts[0]?.output?.value as {
      reason: string
      candidatesScanned: number
      passages: unknown[]
      conflicting: { text?: string }[]
      injectionWithheld: boolean
    }
    expect(toolParts[0]?.output?.ok).toBe(true)
    expect(value.conflicting.length).toBeGreaterThan(0)
    expect(value.injectionWithheld).toBe(true)
    // The reason distinguishes a premise conflict from "nothing relevant".
    expect(value.reason).toBe('ok')
    expect(value.candidatesScanned).toBeGreaterThan(0)
    // The injection and filler documents are withheld, so fewer than the corpus.
    expect(value.passages.length).toBeLessThan(FIXTURE_DOCUMENTS.length)
    // No orchestration telemetry reaches the model-visible result.
    for (const key of ['usage', 'routed', 'mode', 'directive', 'score', 'rerank', 'embedModel']) {
      expect(value, key).not.toHaveProperty(key)
    }

    // The withheld payload's marker appears in no field of the result.
    expect(JSON.stringify(toolParts[0]?.output)).not.toContain(INJECTION_MARKER)

    // ...and nowhere in the messages sent to the mock model.
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? [])
    expect(prompt).not.toContain(INJECTION_MARKER)
    // The behavioural instructions reach the model through the system prompt.
    expect(prompt).toContain('report the conflict')
    expect(prompt).toContain('untrusted')
  })

  it('flags a contradicted claim and a hallucinated claim', async () => {
    const { port } = await setupPipeline()
    const search = await port.search(FALSE_PREMISE_QUERY)
    // The Storage passage is the one the contradicted claim is about.
    const chunkId = [...search.passages, ...search.conflicting].find((passage) =>
      passage.text.includes('plaintext'),
    )?.id
    expect(chunkId).toBeTruthy()

    const contradicted = await port.verifyCitation(CONTRADICTED_CLAIM, chunkId!)
    expect(contradicted?.verdict).toBe('contradicted')

    const fabricated = await port.verifyCitation(HALLUCINATED_CLAIM, chunkId!)
    expect(fabricated?.verdict).toBe('unsupported')
    expect(fabricated?.confidence).toBeNull()
    expect(fabricated?.auto).toBe(false)
  })

  it('reports skipped and premise_conflict reasons instead of a collapsed empty result', async () => {
    const { embedder } = await setupPipeline()
    const deps = (client: TypeSafeClient) => ({
      getSettings: () => useVaultStore.getState().settings,
      embedderFor: () => embedder as unknown as EmbeddingModel,
      typesafe: client,
      cache: createJevCache(),
    })

    const skipping = createRagPort(
      deps({
        async systemOne() {
          return systemOneResult({ needs_retrieval: noulAnswer(0.1), premise_valid: noulAnswer(0.9) })
        },
      } as unknown as TypeSafeClient),
    )
    const skipped = await skipping.search('anything')
    expect(skipped.reason).toBe('skipped')
    expect(skipped.passages).toEqual([])

    const conflicting = createRagPort(
      deps({
        async systemOne() {
          return systemOneResult({ needs_retrieval: noulAnswer(0.9), premise_valid: noulAnswer(0.1) })
        },
      } as unknown as TypeSafeClient),
    )
    // With a supplied context the early premise exit is reachable, and it now
    // reports `premise_conflict` rather than "nothing relevant".
    const result = await conflicting.search('anything', { context: 'context says otherwise' })
    expect(result.reason).toBe('premise_conflict')
    expect(result.passages).toEqual([])
  })

  it('collapses near-duplicate adjacent chunks before returning them', async () => {
    const { port, embedder } = await setupPipeline()
    const repeated = Array.from(
      { length: 40 },
      () => 'Điều 9. Nội dung này được lặp lại nguyên văn nhiều lần trong tài liệu.',
    ).join('\n\n')
    const results = await ingestFiles({
      files: [fileOf('Repeat', repeated)],
      embedder: embedder as unknown as EmbeddingModel,
      chunkSize: 200,
      overlap: 0,
      embedProviderId: 'p1',
      embedModel: 'embed',
    })
    expect(results[0]?.ok).toBe(true)
    await hydrate()

    const search = await port.search('Nội dung được lặp lại')
    const fromRepeat = search.passages.filter((passage) => passage.docTitle === 'Repeat')
    expect(fromRepeat.length).toBe(1)
  })

  it('refuses a chunk id the session never returned', async () => {
    const { port } = await setupPipeline()
    await expect(port.getChunk('invented-id')).resolves.toBeNull()
    await expect(port.verifyCitation('claim', 'invented-id')).resolves.toBeNull()
    await expect(port.getNeighbors('invented-id')).resolves.toBeNull()
  })

  it('reads scoped neighbours inside one document and makes them readable', async () => {
    const { port, embedder } = await setupPipeline()
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `Điều ${i + 1}. Nội dung điều số ${i + 1} có đủ từ để tạo thành một đoạn dài.`,
    )
    const results = await ingestFiles({
      files: [fileOf('Long', paragraphs.join('\n\n'))],
      embedder: embedder as unknown as EmbeddingModel,
      chunkSize: 200,
      overlap: 0,
      embedProviderId: 'p1',
      embedModel: 'embed',
    })
    expect(results[0]?.ok).toBe(true)
    await hydrate()

    const search = await port.search('Nội dung điều số')
    const anchor = search.passages.find((passage) => passage.docTitle === 'Long')
    expect(anchor).toBeTruthy()
    const result = await port.getNeighbors(anchor!.id, { radius: 1 })
    expect(result).not.toBeNull()
    expect(result!.neighbors.length).toBeGreaterThan(0)
    expect(result!.injectionWithheld).toBe(false)
    for (const neighbor of result!.neighbors) {
      expect(neighbor.docTitle).toBe('Long')
      await expect(port.getChunk(neighbor.id)).resolves.not.toBeNull()
    }
  })

  describe.each(BYPASS_CASES)('bypass class: $name', (testCase) => {
    it(`is ${testCase.expectedPassesFilter ? 'counted as passing' : 'filtered'} (${testCase.note})`, async () => {
      const client = createAdversarialTypeSafe()
      const grade = await gradePair(client, FALSE_PREMISE_QUERY, { id: 'x', text: testCase.text })
      const filtered = grade.decision === 'exclude' && grade.answers.contains_injection > 0.7
      expect(!filtered).toBe(testCase.expectedPassesFilter)
    })
  })
})

describe('RAG query rewrite', () => {
  it('rewrites a user-sourced query but never an agent query', async () => {
    const { embedder } = await setupPipeline()
    const rewriteModel = vi.fn(
      () => rewriteReply('ngày pháp luật Việt Nam') as unknown as LanguageModel,
    )
    const port = createRagPort({
      getSettings: () => useVaultStore.getState().settings,
      embedderFor: () => embedder as unknown as EmbeddingModel,
      typesafe: createAdversarialTypeSafe(),
      rewriteModel,
      cache: createJevCache(),
    })

    const userResult = await port.search('luật', { source: 'user' })
    expect(rewriteModel).toHaveBeenCalledTimes(1)
    expect(userResult.query).toBe('ngày pháp luật Việt Nam')

    await port.search('luật', { source: 'agent' })
    expect(rewriteModel).toHaveBeenCalledTimes(1)
  })

  it('falls back to the original query when the rewriter fails', async () => {
    const { embedder } = await setupPipeline()
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('rewriter offline')
      },
    })
    const port = createRagPort({
      getSettings: () => useVaultStore.getState().settings,
      embedderFor: () => embedder as unknown as EmbeddingModel,
      typesafe: createAdversarialTypeSafe(),
      rewriteModel: () => failing as unknown as LanguageModel,
      cache: createJevCache(),
    })

    const result = await port.search('câu hỏi gốc', { source: 'user' })
    expect(result.query).toBe('câu hỏi gốc')
  })
})
