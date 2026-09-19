import { describe, expect, it } from 'vitest'
import type { WorkspaceEntry } from '../tools/types'
import { buildTreeEntries, flattenTree } from './tree'
import type { TreeNode } from './tree'

function entry(path: string, kind: 'file' | 'directory'): WorkspaceEntry {
  return { name: path.split('/').pop() ?? path, path, kind }
}

describe('buildTreeEntries', () => {
  it('returns an empty list for no entries', () => {
    expect(buildTreeEntries([], '')).toEqual([])
  })

  it('sorts directories before files, then by name', () => {
    const nodes = buildTreeEntries(
      [entry('b.txt', 'file'), entry('a', 'directory'), entry('a.txt', 'file'), entry('z', 'directory')],
      '',
    )
    expect(nodes.map((node) => node.name)).toEqual(['a', 'z', 'a.txt', 'b.txt'])
  })

  it('drops blank names and entries outside the parent path', () => {
    const nodes = buildTreeEntries(
      [entry('sub/child.txt', 'file'), entry('other/x.txt', 'file'), { name: '', path: 'sub/', kind: 'directory' }],
      'sub',
    )
    expect(nodes.map((node) => node.path)).toEqual(['sub/child.txt'])
  })
})

describe('flattenTree', () => {
  const tree: TreeNode[] = [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'README.md', path: 'README.md', kind: 'file' },
  ]
  const children = new Map<string, TreeNode[]>([
    [
      'src',
      [
        { name: 'nested', path: 'src/nested', kind: 'directory' },
        { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
      ],
    ],
    ['src/nested', [{ name: 'deep.ts', path: 'src/nested/deep.ts', kind: 'file' }]],
  ])

  it('omits children of collapsed directories', () => {
    const flat = flattenTree(tree, children, new Set())
    expect(flat.map((node) => node.path)).toEqual(['src', 'README.md'])
  })

  it('includes children of expanded directories with depth', () => {
    const flat = flattenTree(tree, children, new Set(['src']))
    expect(flat.map((node) => [node.path, node.depth])).toEqual([
      ['src', 0],
      ['src/nested', 1],
      ['src/index.ts', 1],
      ['README.md', 0],
    ])
  })

  it('recurses through nested expanded directories', () => {
    const flat = flattenTree(tree, children, new Set(['src', 'src/nested']))
    expect(flat.map((node) => [node.path, node.depth])).toEqual([
      ['src', 0],
      ['src/nested', 1],
      ['src/nested/deep.ts', 2],
      ['src/index.ts', 1],
      ['README.md', 0],
    ])
  })
})
