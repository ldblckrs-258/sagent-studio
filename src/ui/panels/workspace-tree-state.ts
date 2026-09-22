import { create } from 'zustand'
import type { WorkspaceFs } from '../../workspace/fs'
import type { TreeNode } from '../../workspace/tree'

/**
 * The folder tree's expansion and its lazy `fs.list` cache, held outside the
 * panel because the rail renders only the active panel: switching tabs unmounts
 * the tree, and local state would collapse it every time.
 *
 * `source` is the folder the cache belongs to. Handle identity is the right key
 * because the workspace store keeps one `WorkspaceFs` per folder and only swaps
 * it when the folder actually changes, so two folders that share a name cannot
 * be mistaken for one another.
 */
export interface WorkspaceTreeState {
  source: WorkspaceFs | null
  rootNodes: TreeNode[]
  children: Map<string, TreeNode[]>
  expanded: Set<string>
  setRoot(source: WorkspaceFs, nodes: TreeNode[]): void
  cacheChildren(path: string, nodes: TreeNode[]): void
  expand(path: string): void
  collapse(path: string): void
  invalidateSubtree(path: string): void
  reset(): void
}

const EMPTY = {
  source: null,
  rootNodes: [] as TreeNode[],
  children: new Map<string, TreeNode[]>(),
  expanded: new Set<string>(),
}

export const useWorkspaceTreeStore = create<WorkspaceTreeState>((set) => ({
  ...EMPTY,

  setRoot(source, nodes) {
    // A different folder invalidates the whole cache, not just the roots.
    set({ source, rootNodes: nodes, children: new Map(), expanded: new Set() })
  },

  cacheChildren(path, nodes) {
    set((state) => ({ children: new Map(state.children).set(path, nodes) }))
  },

  expand(path) {
    set((state) => ({ expanded: new Set(state.expanded).add(path) }))
  },

  collapse(path) {
    set((state) => {
      const expanded = new Set(state.expanded)
      expanded.delete(path)
      return { expanded }
    })
  },

  invalidateSubtree(path) {
    // A rename or move leaves children cached under the old path, and a delete
    // leaves them cached at all; both must go so a later expand re-lists.
    const prefix = path === '' ? '' : `${path}/`
    const within = (key: string): boolean =>
      key === path || key.startsWith(prefix)
    set((state) => {
      const children = new Map(state.children)
      for (const key of children.keys()) if (within(key)) children.delete(key)
      const expanded = new Set(state.expanded)
      for (const key of expanded) if (within(key)) expanded.delete(key)
      return { children, expanded }
    })
  },

  reset() {
    set({ ...EMPTY, children: new Map(), expanded: new Set() })
  },
}))
