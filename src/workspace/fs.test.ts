import { describe, expect, it } from 'vitest'
import {
  WorkspaceLimitError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspacePermissionError,
} from './errors'
import { createFakeWorkspace } from './fake-handle'
import { createWorkspaceFs, resolveSegments } from './fs'

describe('resolveSegments', () => {
  it('accepts a nested relative path', () => {
    expect(resolveSegments('docs/nested/readme.md')).toEqual(['docs', 'nested', 'readme.md'])
  })

  it('rejects every path-escape class', () => {
    for (const path of ['/abs', '../x', 'a\\..\\b', 'C:\\x', '\\\\server\\share', 'nul\0', '.', 'a/./b']) {
      expect(() => resolveSegments(path), path).toThrow(WorkspacePathError)
    }
  })
})

describe('WorkspaceFs', () => {
  it('reads a nested file', async () => {
    const fake = createFakeWorkspace({ 'docs/readme.md': 'hello' })
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.readFile('docs/readme.md')).resolves.toBe('hello')
  })

  it('writes a file and creates its parent directories', async () => {
    const fake = createFakeWorkspace()
    const fs = createWorkspaceFs(fake.handle)

    await fs.writeFile('a/b/c.txt', 'content')
    await expect(fs.readFile('a/b/c.txt')).resolves.toBe('content')
    await expect(fs.list('a/b')).resolves.toMatchObject([{ name: 'c.txt', kind: 'file' }])
  })

  it('lists entries sorted by name', async () => {
    const fake = createFakeWorkspace({ 'root/zeta.txt': 'z', 'root/alpha.txt': 'a' })
    const fs = createWorkspaceFs(fake.handle)
    const names = (await fs.list('root')).map((entry) => entry.name)
    expect(names).toEqual(['alpha.txt', 'zeta.txt'])
  })

  it('creates a directory', async () => {
    const fake = createFakeWorkspace()
    const fs = createWorkspaceFs(fake.handle)
    await fs.makeDir('notes')
    await expect(fs.stat('notes')).resolves.toEqual({ path: 'notes', kind: 'directory', size: 0 })
  })

  it('removes a directory recursively', async () => {
    const fake = createFakeWorkspace({ 'a/b/c.txt': 'deep' })
    const fs = createWorkspaceFs(fake.handle)
    await fs.remove('a')
    await expect(fs.list('')).resolves.toEqual([])
  })

  it('reports a missing entry', async () => {
    const fake = createFakeWorkspace()
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.readFile('missing.txt')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
  })

  it('enforces the read size cap', async () => {
    const fake = createFakeWorkspace({ 'big.txt': '0123456789' })
    const fs = createWorkspaceFs(fake.handle, { sizeCap: 5 })
    await expect(fs.readFile('big.txt')).rejects.toBeInstanceOf(WorkspaceLimitError)
  })

  it('enforces the write size cap before touching the handle', async () => {
    const fake = createFakeWorkspace()
    const fs = createWorkspaceFs(fake.handle, { sizeCap: 5 })
    await expect(fs.writeFile('big.txt', '0123456789')).rejects.toBeInstanceOf(WorkspaceLimitError)
  })

  it('stats a file with its byte size', async () => {
    const fake = createFakeWorkspace({ 'f.txt': 'abc' })
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.stat('f.txt')).resolves.toEqual({ path: 'f.txt', kind: 'file', size: 3 })
  })

  it('maps a denied permission to WorkspacePermissionError', async () => {
    const fake = createFakeWorkspace({ 'f.txt': 'abc' })
    fake.setPermission('denied')
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.ensurePermission('read')).rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(fs.readFile('f.txt')).rejects.toBeInstanceOf(WorkspacePermissionError)
  })

  it('maps a prompt permission to WorkspacePermissionError', async () => {
    const fake = createFakeWorkspace({ 'f.txt': 'abc' })
    fake.setPermission('prompt')
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.list('')).rejects.toBeInstanceOf(WorkspacePermissionError)
  })

  it('rejects a traversal path before touching the handle', async () => {
    const fake = createFakeWorkspace()
    const fs = createWorkspaceFs(fake.handle)
    await expect(fs.readFile('../secret')).rejects.toBeInstanceOf(WorkspacePathError)
    await expect(fs.writeFile('a\\..\\b', 'x')).rejects.toBeInstanceOf(WorkspacePathError)
  })
})
