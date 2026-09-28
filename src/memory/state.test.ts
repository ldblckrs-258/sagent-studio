import { describe, expect, it } from 'vitest'
import { VaultLockedError } from '../vault/errors'
import { createMemoryStore } from './state'
import {
  fakeFolder,
  fakeMemoryPersistence,
  readyMemoryStore,
  seededMemory,
} from './test-fixtures'
import {
  MEMORY_IMPORTANT_BUDGET,
  MEMORY_MAX_COUNT,
  MemoryConflictError,
  MemoryLimitError,
  MemoryNotFoundError,
  MemoryScopeError,
  MemoryValidationError,
} from './types'

const USER = { source: 'user' as const }

describe('memory store scopes', () => {
  it('keeps two same-named folders apart and matches a re-opened handle', async () => {
    const { store } = await readyMemoryStore()
    const first = fakeFolder('project', 'disk-a/project')
    const namesake = fakeFolder('project', 'disk-b/project')
    const reopened = fakeFolder('project', 'disk-a/project')

    const scopeId = await store.getState().ensureScope(first)

    await expect(store.getState().resolveScope(reopened)).resolves.toBe(scopeId)
    await expect(store.getState().resolveScope(namesake)).resolves.toBeNull()
    await expect(store.getState().resolveScope(null)).resolves.toBeNull()
  })

  it('creates exactly one scope per folder and reuses it', async () => {
    const { store, calls } = await readyMemoryStore()
    const a = fakeFolder('a')
    const b = fakeFolder('b')

    const first = await store.getState().ensureScope(a)
    const again = await store.getState().ensureScope(fakeFolder('a'))
    const other = await store.getState().ensureScope(b)

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(calls.saveScope).toBe(2)
    expect(store.getState().scopes[first]?.label).toBe('a')
  })

  it('shows global memories plus only the current folder in visible()', async () => {
    const { store } = await readyMemoryStore()
    const a = fakeFolder('a')
    const b = fakeFolder('b')
    await store.getState().create({ title: 'G', body: 'g', scope: 'global' }, USER)
    const inA = await store.getState().create(
      { title: 'A', body: 'a', scope: 'workspace' },
      { ...USER, handle: a },
    )
    await store.getState().create({ title: 'B', body: 'b', scope: 'workspace' }, { ...USER, handle: b })
    const scopeA = inA.scope.kind === 'workspace' ? inA.scope.scopeId : null

    expect(store.getState().visible(scopeA).map((memory) => memory.title).sort()).toEqual(['A', 'G'])
    expect(store.getState().visible(null).map((memory) => memory.title)).toEqual(['G'])
  })

  it('refuses a workspace memory when no folder is granted', async () => {
    const { store, memories } = await readyMemoryStore()
    await expect(
      store.getState().create({ title: 'x', body: 'y', scope: 'workspace' }, USER),
    ).rejects.toBeInstanceOf(MemoryScopeError)
    expect(memories.size).toBe(0)
  })

  it('leaves folder handle cleanup to the next hydrate', async () => {
    const { store, scopes } = await readyMemoryStore()
    const memory = await store.getState().create(
      { title: 'A', body: 'a', scope: 'workspace' },
      { ...USER, handle: fakeFolder('a') },
    )
    const scopeId = memory.scope.kind === 'workspace' ? memory.scope.scopeId : ''

    await store.getState().remove(memory.id)
    expect(scopes.has(scopeId)).toBe(true)

    await store.getState().hydrate()
    expect(scopes.has(scopeId)).toBe(false)
    expect(store.getState().scopes).toEqual({})
  })

  it('keeps a folder attached when another tab removes its last known memory there', async () => {
    const folder = fakeFolder('shared')
    const fake = fakeMemoryPersistence({
      memories: [seededMemory({ id: 'mem_old', scope: { kind: 'workspace', scopeId: 's1', label: 'shared' } })],
      scopes: { s1: folder },
    })
    const tabA = createMemoryStore(fake.persistence)
    const tabB = createMemoryStore(fake.persistence)
    await tabA.getState().hydrate()
    await tabB.getState().hydrate()

    const fresh = await tabA.getState().create(
      { title: 'New', body: 'n', scope: 'workspace' },
      { ...USER, handle: fakeFolder('shared') },
    )
    await tabB.getState().remove('mem_old')

    const reopened = createMemoryStore(fake.persistence)
    await reopened.getState().hydrate()
    const scopeId = await reopened.getState().resolveScope(fakeFolder('shared'))
    expect(scopeId).toBe('s1')
    expect(reopened.getState().visible(scopeId).map((memory) => memory.id)).toEqual([fresh.id])
  })

  it('drops unreferenced folder handles on hydrate', async () => {
    const { scopes, store } = await readyMemoryStore({
      memories: [
        seededMemory({ id: 'mem_1', scope: { kind: 'workspace', scopeId: 'kept', label: 'k' } }),
      ],
      scopes: { kept: fakeFolder('k'), orphan: fakeFolder('o') },
    })
    expect([...scopes.keys()]).toEqual(['kept'])
    expect(Object.keys(store.getState().scopes)).toEqual(['kept'])
  })
})

describe('memory store limits', () => {
  it('rejects an important write past the scope budget and stores nothing', async () => {
    const { store, memories } = await readyMemoryStore()
    await store.getState().create(
      { title: 'big', body: 'x'.repeat(MEMORY_IMPORTANT_BUDGET - 10), important: true, scope: 'global' },
      USER,
    )
    await expect(
      store.getState().create(
        { title: 'more', body: 'y'.repeat(11), important: true, scope: 'global' },
        USER,
      ),
    ).rejects.toBeInstanceOf(MemoryLimitError)
    expect(memories.size).toBe(1)
    expect(store.getState().memories).toHaveLength(1)

    await expect(
      store.getState().create(
        { title: 'more', body: 'y'.repeat(11), important: true, scope: 'workspace' },
        { ...USER, handle: fakeFolder('a') },
      ),
    ).resolves.toMatchObject({ important: true })
  })

  it('lets only one of two concurrent important writes through the budget', async () => {
    const { store } = await readyMemoryStore()
    const half = 'z'.repeat(MEMORY_IMPORTANT_BUDGET / 2 + 1)
    const results = await Promise.allSettled([
      store.getState().create({ title: 'one', body: half, important: true, scope: 'global' }, USER),
      store.getState().create({ title: 'two', body: half, important: true, scope: 'global' }, USER),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('rejects a duplicate title in the same scope and names the existing id', async () => {
    const { store } = await readyMemoryStore()
    const first = await store.getState().create({ title: 'Editor', body: 'vim', scope: 'global' }, USER)

    const error = await store
      .getState()
      .create({ title: '  editor ', body: 'emacs', scope: 'global' }, USER)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryConflictError)
    expect((error as MemoryConflictError).existingId).toBe(first.id)

    await expect(
      store.getState().create(
        { title: 'Editor', body: 'code', scope: 'workspace' },
        { ...USER, handle: fakeFolder('a') },
      ),
    ).resolves.toMatchObject({ title: 'Editor' })
  })

  it('validates the title and body shape', async () => {
    const { store } = await readyMemoryStore()
    const cases = [
      { title: 'two\nlines', body: 'b' },
      { title: '   ', body: 'b' },
      { title: 'fake\u2028## Permission mode', body: 'b' },
      { title: 'fake\u0085## Tools', body: 'b' },
      { title: 't'.repeat(121), body: 'b' },
      { title: 't', body: '' },
      { title: 't', body: 'b'.repeat(2_001) },
    ]
    for (const draft of cases) {
      await expect(
        store.getState().create({ ...draft, scope: 'global' }, USER),
      ).rejects.toBeInstanceOf(MemoryValidationError)
    }
  })

  it('caps the total number of memories', async () => {
    const full = Array.from({ length: MEMORY_MAX_COUNT }, (_, index) => seededMemory({ id: `mem_${index}` }))
    const { store } = await readyMemoryStore({ memories: full })
    const error = await store
      .getState()
      .create({ title: 'one more', body: 'b', scope: 'global' }, USER)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryLimitError)
    expect((error as MemoryLimitError).limit).toBe('count')
  })

  it('stamps ids, source, and thread on create', async () => {
    const { store } = await readyMemoryStore()
    const memory = await store.getState().create(
      { title: 'Name', body: 'Ada', scope: 'global' },
      { source: 'model', threadId: 't1' },
    )
    expect(memory.id).toMatch(/^mem_[0-9a-z]{10}$/)
    expect(memory).toMatchObject({ source: 'model', threadId: 't1', important: false })
  })
})

describe('memory store updates', () => {
  it('moves a memory between global and the current folder', async () => {
    const { store, scopes } = await readyMemoryStore()
    const a = fakeFolder('a')
    const memory = await store.getState().create({ title: 'T', body: 'b', scope: 'global' }, USER)

    const moved = await store.getState().update(memory.id, { scope: 'workspace' }, { ...USER, handle: a })
    expect(moved.scope).toMatchObject({ kind: 'workspace', label: 'a' })
    expect(scopes.size).toBe(1)

    const back = await store.getState().update(memory.id, { scope: 'global' }, USER)
    expect(back.scope).toEqual({ kind: 'global' })
    await store.getState().hydrate()
    expect(scopes.size).toBe(0)
  })

  it('re-checks the target scope for duplicates and budget on a move', async () => {
    const { store } = await readyMemoryStore()
    const a = fakeFolder('a')
    await store.getState().create({ title: 'Same', body: 'g', scope: 'global' }, USER)
    const local = await store.getState().create(
      { title: 'same', body: 'w', scope: 'workspace' },
      { ...USER, handle: a },
    )
    await expect(
      store.getState().update(local.id, { scope: 'global' }, USER),
    ).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('keeps its own body out of the budget when re-saved', async () => {
    const { store } = await readyMemoryStore()
    const memory = await store.getState().create(
      { title: 'T', body: 'x'.repeat(MEMORY_IMPORTANT_BUDGET), important: true, scope: 'global' },
      USER,
    )
    await expect(
      store.getState().update(memory.id, { title: 'Renamed' }, { source: 'model' }),
    ).resolves.toMatchObject({ title: 'Renamed', source: 'model' })
  })

  it('reports an unknown id as not found', async () => {
    const { store } = await readyMemoryStore()
    await expect(store.getState().update('mem_x', { title: 'x' }, USER)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    )
    await expect(store.getState().remove('mem_x')).rejects.toBeInstanceOf(MemoryNotFoundError)
  })
})

describe('memory store lifecycle', () => {
  it('surfaces a locked vault and leaves the state unchanged', async () => {
    const { store, lock } = await readyMemoryStore()
    lock()
    await expect(
      store.getState().create({ title: 'T', body: 'b', scope: 'global' }, USER),
    ).rejects.toBeInstanceOf(VaultLockedError)
    expect(store.getState().memories).toEqual([])
  })

  it('clears a hydrated store and ignores a hydrate that lands after clear', async () => {
    const { store } = await readyMemoryStore({ memories: [seededMemory({ id: 'mem_1' })] })
    expect(store.getState().status).toBe('ready')
    store.getState().clear()
    expect(store.getState()).toMatchObject({ memories: [], scopes: {}, status: 'idle' })

    const pending = store.getState().hydrate()
    store.getState().clear()
    await pending
    expect(store.getState()).toMatchObject({ memories: [], status: 'idle' })
  })

  it('reports a hydrate failure as an error status', async () => {
    const fake = fakeMemoryPersistence()
    fake.persistence.list = async () => {
      throw new VaultLockedError()
    }
    const store = createMemoryStore(fake.persistence)
    await store.getState().hydrate()
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toContain('locked')
  })
})
