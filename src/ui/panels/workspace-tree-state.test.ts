import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceFs } from '../../workspace/fs'
import type { TreeNode } from '../../workspace/tree'
import { useWorkspaceTreeStore } from './workspace-tree-state'

function fakeFs(name: string): WorkspaceFs {
  return { handle: { name } } as unknown as WorkspaceFs
}

const node = (name: string, kind: TreeNode['kind'] = 'directory'): TreeNode => ({
  name,
  path: name,
  kind,
})

describe('workspace tree state', () => {
  beforeEach(() => {
    useWorkspaceTreeStore.getState().reset()
  })

  it('survives the panel unmounting, so switching tabs does not collapse the tree', () => {
    const fs = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(fs, [node('src')])
    useWorkspaceTreeStore.getState().cacheChildren('src', [node('main.ts', 'file')])
    useWorkspaceTreeStore.getState().expand('src')

    // Nothing here holds a React tree: the state is the store's, not a mounted
    // component's, which is exactly what a tab switch relies on.
    const state = useWorkspaceTreeStore.getState()
    expect(state.source).toBe(fs)
    expect(state.expanded.has('src')).toBe(true)
    expect(state.children.get('src')).toEqual([node('main.ts', 'file')])
  })

  it('drops the cache when the roots come from a different folder', () => {
    const first = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(first, [node('src')])
    useWorkspaceTreeStore.getState().cacheChildren('src', [node('main.ts', 'file')])
    useWorkspaceTreeStore.getState().expand('src')

    const second = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(second, [node('lib')])

    const state = useWorkspaceTreeStore.getState()
    expect(state.source).toBe(second)
    expect(state.rootNodes).toEqual([node('lib')])
    expect(state.expanded.size).toBe(0)
    expect(state.children.size).toBe(0)
  })

  it('collapses one directory without touching its cached children', () => {
    const fs = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(fs, [node('src'), node('docs')])
    useWorkspaceTreeStore.getState().cacheChildren('src', [node('main.ts', 'file')])
    useWorkspaceTreeStore.getState().expand('src')
    useWorkspaceTreeStore.getState().expand('docs')

    useWorkspaceTreeStore.getState().collapse('src')

    const state = useWorkspaceTreeStore.getState()
    expect(state.expanded.has('src')).toBe(false)
    expect(state.expanded.has('docs')).toBe(true)
    // Re-expanding must not cost another `fs.list`.
    expect(state.children.get('src')).toEqual([node('main.ts', 'file')])
  })

  it('drops cached children under a renamed or deleted directory, keeping siblings', () => {
    const fs = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(fs, [node('src'), node('docs')])
    useWorkspaceTreeStore.getState().cacheChildren('src', [node('src/index.ts', 'file')])
    useWorkspaceTreeStore.getState().cacheChildren('src/nested', [node('src/nested/deep.ts', 'file')])
    useWorkspaceTreeStore.getState().cacheChildren('docs', [node('docs/guide.md', 'file')])
    useWorkspaceTreeStore.getState().expand('src')
    useWorkspaceTreeStore.getState().expand('src/nested')
    useWorkspaceTreeStore.getState().expand('docs')

    useWorkspaceTreeStore.getState().invalidateSubtree('src')

    const state = useWorkspaceTreeStore.getState()
    expect(state.children.has('src')).toBe(false)
    expect(state.children.has('src/nested')).toBe(false)
    expect(state.expanded.has('src')).toBe(false)
    expect(state.expanded.has('src/nested')).toBe(false)
    expect(state.children.get('docs')).toEqual([node('docs/guide.md', 'file')])
    expect(state.expanded.has('docs')).toBe(true)
  })

  it('leaves an unrelated file path untouched', () => {
    const fs = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(fs, [node('src')])
    useWorkspaceTreeStore.getState().cacheChildren('src', [node('src/index.ts', 'file')])
    useWorkspaceTreeStore.getState().expand('src')

    useWorkspaceTreeStore.getState().invalidateSubtree('src/index.ts')

    const state = useWorkspaceTreeStore.getState()
    expect(state.children.get('src')).toEqual([node('src/index.ts', 'file')])
    expect(state.expanded.has('src')).toBe(true)
  })

  it('forgets the folder on reset, so a refresh re-reads it', () => {
    const fs = fakeFs('project')
    useWorkspaceTreeStore.getState().setRoot(fs, [node('src')])
    useWorkspaceTreeStore.getState().expand('src')

    useWorkspaceTreeStore.getState().reset()

    const state = useWorkspaceTreeStore.getState()
    expect(state.source).toBeNull()
    expect(state.rootNodes).toEqual([])
    expect(state.expanded.size).toBe(0)
    expect(state.children.size).toBe(0)
  })
})
