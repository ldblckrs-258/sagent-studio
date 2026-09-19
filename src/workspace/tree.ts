import type { WorkspaceEntry } from '../tools/types'

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface FlatTreeNode extends TreeNode {
  depth: number
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Maps one `fs.list` level to sorted tree nodes, directories before files. */
export function buildTreeEntries(
  entries: readonly WorkspaceEntry[],
  parentPath: string,
): TreeNode[] {
  const prefix = parentPath === '' ? '' : `${parentPath}/`
  return entries
    .filter((entry) => prefix === '' || entry.path.startsWith(prefix))
    .filter((entry) => entry.name.length > 0)
    .map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind }))
    .sort(compareNodes)
}

/**
 * Flattens only the expanded nodes. Children are supplied per path from the
 * panel's lazy `fs.list` cache, so a collapsed directory costs nothing.
 */
export function flattenTree(
  nodes: readonly TreeNode[],
  childrenByPath: ReadonlyMap<string, readonly TreeNode[]>,
  expanded: ReadonlySet<string>,
  depth = 0,
): FlatTreeNode[] {
  const out: FlatTreeNode[] = []
  for (const node of nodes) {
    out.push({ ...node, depth })
    if (node.kind !== 'directory' || !expanded.has(node.path)) continue
    const children = childrenByPath.get(node.path)
    if (children && children.length > 0) {
      out.push(...flattenTree(children, childrenByPath, expanded, depth + 1))
    }
  }
  return out
}
