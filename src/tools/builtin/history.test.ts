import type { ToolSet } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../../workspace/fake-handle'
import type { WorkspaceFs } from '../../workspace/fs'
import { createWorkspaceFs } from '../../workspace/fs'
import { workspaceJournal } from '../../workspace/journal'
import { ToolRegistry } from '../registry'
import { createHistoryToolProvider } from './history'
import { workspaceToolProvider } from './workspace'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function build(initial: Record<string, string> = {}) {
  const fake = createFakeWorkspace(initial)
  const workspace: WorkspaceFs = createWorkspaceFs(fake.handle)
  const registry = new ToolRegistry()
  registry.registerProvider(workspaceToolProvider)
  registry.registerProvider(createHistoryToolProvider())
  return registry.buildToolSet(undefined, { workspace })
}

describe('history tools', () => {
  beforeEach(() => {
    workspaceJournal.clear()
  })

  it('checkpoints, diffs, and restores a file edit', async () => {
    const toolSet = build()

    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'one\ntwo\nthree' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({ label: 'before edit' }, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await executor(toolSet, 'edit_file')(
      { path: 'a.txt', old_string: 'two', new_string: 'TWO' },
      CALL,
    )

    const diff = await executor(toolSet, 'diff')({ path: 'a.txt' }, CALL)
    expect(diff).toMatchObject({ ok: true, value: { changed: true, addedLines: 1, removedLines: 1 } })
    const diffText = (diff as { value: { diff: string } }).value.diff
    expect(diffText).toContain('--- a/a.txt')
    expect(diffText).toContain('+++ b/a.txt')
    expect(diffText).toContain('@@ -2,1 +2,1 @@')
    expect(diffText).toContain('- two')
    expect(diffText).toContain('+ TWO')

    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { restored: ['a.txt'], removed: [] },
    })
    await expect(executor(toolSet, 'read_file')({ path: 'a.txt' }, CALL)).resolves.toMatchObject({
      value: { content: 'one\ntwo\nthree' },
    })
  })

  it('removes a file that was created after the checkpoint', async () => {
    const toolSet = build({ 'keep.txt': 'keep' })
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id
    await executor(toolSet, 'write_file')({ path: 'new.txt', content: 'fresh' }, CALL)

    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { removed: ['new.txt'] },
    })
    await expect(executor(toolSet, 'read_file')({ path: 'new.txt' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('reports history hashes without file contents', async () => {
    const toolSet = build({ 'a.txt': 'x' })
    await executor(toolSet, 'edit_file')({ path: 'a.txt', old_string: 'x', new_string: 'y' }, CALL)
    const history = await executor(toolSet, 'history')({ path: 'a.txt' }, CALL)
    expect(history).toMatchObject({
      ok: true,
      value: { entries: [{ kind: 'edit', path: 'a.txt' }] },
    })
  })

  it('fails restore for an unknown checkpoint', async () => {
    const toolSet = build({})
    await expect(executor(toolSet, 'restore')({ id: 'cp-999' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })
})
