import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { bindMemoryPort } from '../../memory/port'
import { fakeFolder, readyMemoryStore, seededMemory } from '../../memory/test-fixtures'
import type { MemorySeed } from '../../memory/test-fixtures'
import { MEMORY_IMPORTANT_BUDGET } from '../../memory/types'
import { ToolRegistry } from '../registry'
import type { ToolResult } from '../result'
import type { MemoryPort } from '../types'
import { createMemoryToolProvider } from './memory'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function build(port: MemoryPort | undefined): ToolSet {
  const registry = new ToolRegistry()
  registry.registerProvider(createMemoryToolProvider())
  return registry.buildToolSet(undefined, port ? { memory: port } : {})
}

async function call(toolSet: ToolSet, name: string, input: unknown): Promise<ToolResult> {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return (await execute(input, CALL)) as ToolResult
}

async function setup(options: { seed?: MemorySeed; folder?: FileSystemDirectoryHandle } = {}) {
  const fake = await readyMemoryStore(options.seed)
  const handle = options.folder ?? null
  const scopeId = await fake.store.getState().resolveScope(handle)
  const port = bindMemoryPort({ store: fake.store.getState(), scopeId, handle, threadId: 't1' })
  return { ...fake, port, tools: build(port) }
}

describe('createMemoryToolProvider', () => {
  it('contributes the four memory tools only when a memory port exists', async () => {
    const provider = createMemoryToolProvider()
    expect(provider.names).toEqual(['remember', 'update_memory', 'forget', 'recall_memory'])
    expect(provider.isAvailable({})).toBe(false)
    const { port } = await setup()
    expect(provider.isAvailable({ memory: port })).toBe(true)
    expect(Object.keys(build(undefined))).toEqual([])
  })

  it('remembers a global memory by default, stamped as written by the model', async () => {
    const { tools, memories } = await setup()
    const result = await call(tools, 'remember', { title: 'Name', body: 'Call me Ada.' })
    expect(result).toMatchObject({
      ok: true,
      value: { memory: { title: 'Name', body: 'Call me Ada.', scope: 'global', important: false, source: 'model' } },
    })
    expect([...memories.values()][0]).toMatchObject({ threadId: 't1', source: 'model' })
  })

  it('returns conflict with the existing id instead of piling up a duplicate', async () => {
    const { tools, memories } = await setup()
    const first = await call(tools, 'remember', { title: 'Editor', body: 'vim' })
    const firstId = (first.value as { memory: { id: string } }).memory.id

    const second = await call(tools, 'remember', { title: 'editor', body: 'emacs' })

    expect(second).toMatchObject({ ok: false, code: 'conflict', value: { existingId: firstId } })
    expect(second.hint).toContain('update_memory')
    expect(second.hint).toContain(firstId)
    expect(memories.size).toBe(1)
  })

  it('refuses a workspace memory with no folder and says how to fix it', async () => {
    const { tools, memories } = await setup()
    const result = await call(tools, 'remember', { title: 'T', body: 'b', scope: 'workspace' })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_input',
      hint: 'Grant a workspace folder, or save it as global.',
    })
    expect(memories.size).toBe(0)
  })

  it('rejects an unknown scope value', async () => {
    const { tools } = await setup()
    const result = await call(tools, 'remember', { title: 'T', body: 'b', scope: 'team' })
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('cannot edit or forget a memory that belongs to another folder', async () => {
    const other = seededMemory({
      id: 'mem_other',
      scope: { kind: 'workspace', scopeId: 'folder-b', label: 'b' },
    })
    const { tools, memories } = await setup({
      seed: { memories: [other], scopes: { 'folder-b': fakeFolder('b') } },
      folder: fakeFolder('a'),
    })

    const update = await call(tools, 'update_memory', { id: 'mem_other', body: 'hijacked' })
    const forget = await call(tools, 'forget', { id: 'mem_other' })
    const recall = await call(tools, 'recall_memory', { ids: ['mem_other'] })

    expect(update).toMatchObject({ ok: false, code: 'not_found' })
    expect(forget).toMatchObject({ ok: false, code: 'not_found' })
    expect(recall).toMatchObject({ ok: true, value: { memories: [], missing: ['mem_other'] } })
    expect(memories.get('mem_other')?.body).toBe('body')
  })

  it('returns memory_full past the important budget and stores nothing', async () => {
    const { tools, memories } = await setup()
    await call(tools, 'remember', {
      title: 'Big',
      body: 'x'.repeat(MEMORY_IMPORTANT_BUDGET),
      important: true,
    })
    const result = await call(tools, 'remember', { title: 'More', body: 'y', important: true })
    expect(result).toMatchObject({ ok: false, code: 'memory_full' })
    expect(result.hint).toContain('important')
    expect(memories.size).toBe(1)
  })

  it('reports a locked vault as disabled, not as a runtime error', async () => {
    const { tools, lock } = await setup()
    lock()
    const result = await call(tools, 'remember', { title: 'T', body: 'b' })
    expect(result).toMatchObject({ ok: false, code: 'disabled' })
  })

  it('updates the fields it is given and requires at least one', async () => {
    const { tools } = await setup({ seed: { memories: [seededMemory({ id: 'mem_1', title: 'Old' })] } })
    const empty = await call(tools, 'update_memory', { id: 'mem_1' })
    expect(empty).toMatchObject({ ok: false, code: 'invalid_input' })

    const updated = await call(tools, 'update_memory', { id: 'mem_1', title: 'New', important: true })
    expect(updated).toMatchObject({
      ok: true,
      value: { memory: { id: 'mem_1', title: 'New', body: 'body', important: true, source: 'model' } },
    })
  })

  it('forgets a visible memory', async () => {
    const { tools, memories } = await setup({ seed: { memories: [seededMemory({ id: 'mem_1' })] } })
    const result = await call(tools, 'forget', { id: 'mem_1' })
    expect(result).toEqual({ ok: true, code: 'ok', value: { id: 'mem_1', forgotten: true } })
    expect(memories.size).toBe(0)
  })
})

describe('recall_memory', () => {
  it('requires exactly one of ids or query', async () => {
    const { tools } = await setup()
    expect(await call(tools, 'recall_memory', {})).toMatchObject({ code: 'invalid_input' })
    expect(await call(tools, 'recall_memory', { ids: ['a'], query: 'a' })).toMatchObject({
      code: 'invalid_input',
    })
    expect(await call(tools, 'recall_memory', { ids: [] })).toMatchObject({ code: 'invalid_input' })
    expect(await call(tools, 'recall_memory', { query: '  ' })).toMatchObject({
      code: 'invalid_input',
    })
    expect(
      await call(tools, 'recall_memory', { ids: Array.from({ length: 21 }, (_, i) => `m${i}`) }),
    ).toMatchObject({ code: 'invalid_input' })
  })

  it('matches a query case-insensitively over title and body, newest first, capped at 20', async () => {
    const seeded = Array.from({ length: 25 }, (_, index) =>
      seededMemory({ id: `mem_${index}`, title: `Note ${index}`, body: 'uses TypeScript', updatedAt: index }),
    )
    seeded.push(seededMemory({ id: 'mem_title', title: 'typescript style', body: 'tabs', updatedAt: 100 }))
    seeded.push(seededMemory({ id: 'mem_none', title: 'Coffee', body: 'black', updatedAt: 200 }))
    const { tools } = await setup({ seed: { memories: seeded } })

    const result = await call(tools, 'recall_memory', { query: 'TYPESCRIPT' })
    const ids = (result.value as { memories: Array<{ id: string }> }).memories.map((m) => m.id)

    expect(ids).toHaveLength(20)
    expect(ids[0]).toBe('mem_title')
    expect(ids[1]).toBe('mem_24')
    expect(ids).not.toContain('mem_none')
  })

  it('returns bodies by id and lists unknown ids as missing', async () => {
    const { tools } = await setup({
      seed: { memories: [seededMemory({ id: 'mem_1', body: 'Prefers pnpm.' })] },
    })
    const result = await call(tools, 'recall_memory', { ids: ['mem_1', 'mem_gone'] })
    expect(result).toMatchObject({
      ok: true,
      value: { memories: [{ id: 'mem_1', body: 'Prefers pnpm.' }], missing: ['mem_gone'] },
    })
  })
})
