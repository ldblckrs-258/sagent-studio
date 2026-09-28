import { describe, expect, it } from 'vitest'
import { createMemoryPort } from './port'
import { fakeFolder, readyMemoryStore, seededMemory } from './test-fixtures'
import { MEMORY_INDEX_MAX } from './types'

function scoped(id: string, scopeId: string) {
  return seededMemory({ id, scope: { kind: 'workspace', scopeId, label: scopeId } })
}

async function folders() {
  const a = fakeFolder('project', 'disk/a/project')
  const b = fakeFolder('project', 'disk/b/project')
  const fake = await readyMemoryStore({
    memories: [seededMemory({ id: 'mem_global' }), scoped('mem_a', 'scope-a'), scoped('mem_b', 'scope-b')],
    scopes: { 'scope-a': a, 'scope-b': b },
  })
  return { ...fake, a, b }
}

function ids(port: { visible(): ReadonlyArray<{ id: string }> }): string[] {
  return port.visible().map((memory) => memory.id).sort()
}

describe('createMemoryPort', () => {
  it('shows global memories plus only the current folder, even when folder names match', async () => {
    const { store, a, b } = await folders()
    const reopenedA = fakeFolder('project', 'disk/a/project')

    const inA = await createMemoryPort({ store: store.getState(), handle: reopenedA })
    const inB = await createMemoryPort({ store: store.getState(), handle: b })
    const none = await createMemoryPort({ store: store.getState(), handle: null })

    expect(ids(inA)).toEqual(['mem_a', 'mem_global'])
    expect(ids(inB)).toEqual(['mem_b', 'mem_global'])
    expect(ids(none)).toEqual(['mem_global'])
    expect(a.name).toBe(b.name)
  })

  it('sees a workspace memory it just created for a folder with no scope yet', async () => {
    const { store } = await readyMemoryStore()
    const port = await createMemoryPort({ store: store.getState(), handle: fakeFolder('fresh'), threadId: 't1' })

    const memory = await port.create({ title: 'Local', body: 'b', scope: 'workspace' })

    expect(memory).toMatchObject({ source: 'model', threadId: 't1', scope: { kind: 'workspace', label: 'fresh' } })
    expect(port.visible().map((entry) => entry.id)).toEqual([memory.id])
  })

  it('puts important memories in full and the rest in a capped index', async () => {
    const plain = Array.from({ length: MEMORY_INDEX_MAX + 5 }, (_, index) =>
      seededMemory({ id: `mem_${index}`, updatedAt: index }),
    )
    const important = seededMemory({ id: 'mem_imp', body: 'full body', important: true, updatedAt: 1_000 })
    const { store } = await readyMemoryStore({ memories: [...plain, important] })

    const view = (await createMemoryPort({ store: store.getState(), handle: null })).promptView()

    expect(view.important).toEqual([
      { id: 'mem_imp', title: 'mem_imp', body: 'full body', scopeKind: 'global' },
    ])
    expect(view.index).toHaveLength(MEMORY_INDEX_MAX)
    expect(view.index[0]?.id).toBe(`mem_${MEMORY_INDEX_MAX + 4}`)
    expect(view.index.some((entry) => entry.id === 'mem_imp')).toBe(false)
    expect(view.hidden).toBe(5)
  })

  it('reads the store live, so a panel delete shows in the next view', async () => {
    const { store } = await readyMemoryStore({ memories: [seededMemory({ id: 'mem_1' })] })
    const port = await createMemoryPort({ store: store.getState(), handle: null })
    expect(port.promptView().index).toHaveLength(1)

    await store.getState().remove('mem_1')

    expect(port.promptView().index).toEqual([])
  })
})
