import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../../workspace/fake-handle'
import { createWorkspaceFs } from '../../workspace/fs'
import { WorkspacePathError } from '../../workspace/errors'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { ToolSet } from 'ai'
import { workspaceToolProvider } from './workspace'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

async function build(initial: Record<string, string> = {}) {
  const fake = createFakeWorkspace(initial)
  const workspace = createWorkspaceFs(fake.handle)
  const registry = new ToolRegistry()
  registry.registerProvider(workspaceToolProvider)
  return { fake, toolSet: registry.buildToolSet(undefined, { workspace }) }
}

describe('workspaceToolProvider', () => {
  it('is unavailable without a workspace port', () => {
    expect(workspaceToolProvider.isAvailable({})).toBe(false)
    expect(workspaceToolProvider.isAvailable({ workspace: createWorkspaceFs(createFakeWorkspace().handle) })).toBe(true)
    expect(() => workspaceToolProvider.create('read_file', {})).toThrow(ToolRuntimeUnavailableError)
  })

  it('contributes the five system tools', async () => {
    const { toolSet } = await build()
    expect(Object.keys(toolSet)).toEqual([
      'list_dir',
      'make_dir',
      'read_file',
      'remove',
      'write_file',
    ])
  })

  it('reads and writes through the workspace', async () => {
    const { toolSet } = await build({ 'notes.txt': 'original' })
    await expect(executor(toolSet, 'read_file')({ path: 'notes.txt' }, CALL)).resolves.toEqual({
      path: 'notes.txt',
      content: 'original',
    })

    await expect(
      executor(toolSet, 'write_file')({ path: 'deep/new.txt', content: 'hi' }, CALL),
    ).resolves.toEqual({ path: 'deep/new.txt', bytes: 2 })
    await expect(executor(toolSet, 'read_file')({ path: 'deep/new.txt' }, CALL)).resolves.toEqual({
      path: 'deep/new.txt',
      content: 'hi',
    })
  })

  it('makes a directory and lists it', async () => {
    const { toolSet } = await build()
    await executor(toolSet, 'make_dir')({ path: 'notes' }, CALL)
    await expect(executor(toolSet, 'list_dir')({}, CALL)).resolves.toEqual({
      path: '',
      entries: [{ name: 'notes', path: 'notes', kind: 'directory' }],
    })
  })

  it('removes an entry', async () => {
    const { toolSet } = await build({ 'gone.txt': 'x' })
    await expect(executor(toolSet, 'remove')({ path: 'gone.txt' }, CALL)).resolves.toEqual({
      path: 'gone.txt',
      removed: true,
    })
    await expect(executor(toolSet, 'list_dir')({}, CALL)).resolves.toEqual({ path: '', entries: [] })
  })

  it('rejects a traversal path through the tool boundary', async () => {
    const { toolSet } = await build()
    await expect(executor(toolSet, 'read_file')({ path: '../escape' }, CALL)).rejects.toBeInstanceOf(
      WorkspacePathError,
    )
  })
})
