import type { ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RestoreApplyError, WorkspacePermissionError } from '../../workspace/errors'
import { createFakeWorkspace } from '../../workspace/fake-handle'
import type { WorkspaceFs } from '../../workspace/fs'
import { createWorkspaceFs } from '../../workspace/fs'
import { workspaceJournal } from '../../workspace/journal'
import { applyRestore } from '../../workspace/journal-io'
import { resetPathLocks } from '../../workspace/lock'
import { executeFsCall } from '../../sandbox/fs-bridge'
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
  return { workspace, toolSet: registry.buildToolSet(undefined, { workspace }) }
}

function sandboxWrite(workspace: WorkspaceFs, path: string, data: string) {
  return executeFsCall(workspace, {
    kind: 'fs.call',
    runId: 'run-1',
    requestId: 'req-1',
    op: 'write',
    path,
    data,
  })
}

describe('history tools', () => {
  beforeEach(() => {
    workspaceJournal.clear()
    resetPathLocks()
  })

  it('checkpoints, diffs, and restores a file edit', async () => {
    const { toolSet } = build()

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
    const { toolSet } = build({ 'keep.txt': 'keep' })
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
    const { toolSet } = build({ 'a.txt': 'x' })
    await executor(toolSet, 'edit_file')({ path: 'a.txt', old_string: 'x', new_string: 'y' }, CALL)
    const history = await executor(toolSet, 'history')({ path: 'a.txt' }, CALL)
    expect(history).toMatchObject({
      ok: true,
      value: { entries: [{ kind: 'edit', path: 'a.txt' }] },
    })
  })

  it('fails restore for an unknown checkpoint and points at the id, not the label', async () => {
    const { toolSet } = build({})
    await executor(toolSet, 'checkpoint')({ label: 'pre-write' }, CALL)
    const result = (await executor(toolSet, 'restore')({ id: 'pre-write' }, CALL)) as {
      ok: boolean
      code: string
      message: string
      hint: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    expect(result.message).toContain('id "pre-write"')
    expect(result.hint).toContain('not its label')
  })

  it('journals a sandbox bridge write so restore can undo it', async () => {
    const { workspace, toolSet } = build({})
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await sandboxWrite(workspace, 'from-sandbox.txt', 'CREATED by SANDBOX')

    await expect(executor(toolSet, 'history')({ path: 'from-sandbox.txt' }, CALL)).resolves.toMatchObject(
      { value: { entries: [{ kind: 'write', path: 'from-sandbox.txt' }] } },
    )
    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { removed: ['from-sandbox.txt'] },
    })
    await expect(workspace.readFile('from-sandbox.txt')).rejects.toThrow()
  })

  it('reverts a sandbox bridge overwrite of a journaled file', async () => {
    const { workspace, toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await sandboxWrite(workspace, 'a.txt', 'SANDBOX OVERWRITE')

    const history = await executor(toolSet, 'history')({ path: 'a.txt' }, CALL)
    expect((history as { value: { entries: unknown[] } }).value.entries).toHaveLength(2)
    const diff = await executor(toolSet, 'diff')({ path: 'a.txt', since: id }, CALL)
    expect(diff).toMatchObject({ ok: true, value: { changed: true } })
    await executor(toolSet, 'restore')({ id }, CALL)
    await expect(workspace.readFile('a.txt')).resolves.toBe('original')
  })

  it('restores a file moved after the checkpoint', async () => {
    const { workspace, toolSet } = build({ 'a.txt': 'original' })
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await executor(toolSet, 'move')({ from: 'a.txt', to: 'b.txt' }, CALL)

    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { restored: ['a.txt'], removed: ['b.txt'] },
    })
    await expect(workspace.readFile('a.txt')).resolves.toBe('original')
  })

  it('removes a copy made after the checkpoint', async () => {
    const { workspace, toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await executor(toolSet, 'copy')({ from: 'a.txt', to: 'b.txt' }, CALL)

    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { removed: ['b.txt'] },
    })
    await expect(workspace.readFile('a.txt')).resolves.toBe('original')
  })

  it('reports a directory move as unrestorable instead of ignoring it', async () => {
    const { toolSet } = build({ 'dir/f.txt': 'inside' })
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id

    await executor(toolSet, 'move')({ from: 'dir', to: 'moved' }, CALL)

    const result = (await executor(toolSet, 'restore')({ id }, CALL)) as {
      ok: boolean
      value: { unrestorable: string[] }
    }
    expect(result.ok).toBe(true)
    expect(result.value.unrestorable).toEqual(expect.arrayContaining(['dir', 'moved']))
  })

  it('serializes a read issued in the same step as a restore', async () => {
    const { toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'changed' }, CALL)

    const restore = executor(toolSet, 'restore')({ id }, CALL)
    const read = executor(toolSet, 'read_file')({ path: 'a.txt' }, CALL)
    await restore
    await expect(read).resolves.toMatchObject({ value: { content: 'original' } })
  })

  it('keeps the tool error for a write that fails mid-restore', async () => {
    const { workspace, toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const checkpoint = await executor(toolSet, 'checkpoint')({}, CALL)
    const id = (checkpoint as { value: { id: string } }).value.id
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'changed' }, CALL)
    vi.spyOn(workspace, 'writeFile').mockRejectedValueOnce(new WorkspacePermissionError())

    await expect(executor(toolSet, 'restore')({ id }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'permission_denied',
    })
  })
})

describe('applyRestore', () => {
  beforeEach(() => {
    workspaceJournal.clear()
    resetPathLocks()
  })

  it('leaves a file changed outside the journal in place and reports it as a conflict', async () => {
    const { workspace, toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    await executor(toolSet, 'write_file')({ path: 'b.txt', content: 'original' }, CALL)
    const marker = workspaceJournal.head()
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'agent' }, CALL)
    await executor(toolSet, 'write_file')({ path: 'b.txt', content: 'agent' }, CALL)
    await workspace.writeFile('a.txt', 'manual')

    const plan = workspaceJournal.planRestoreAt(marker)
    const outcome = await applyRestore(workspaceJournal, workspace, plan.changes, {
      checkConflicts: true,
    })

    expect(outcome).toEqual({ restored: ['b.txt'], removed: [], skipped: [], conflicts: ['a.txt'] })
    await expect(workspace.readFile('a.txt')).resolves.toBe('manual')
    await expect(workspace.readFile('b.txt')).resolves.toBe('original')
  })

  it('names the files already restored when a later change fails', async () => {
    const { workspace, toolSet } = build({})
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'original' }, CALL)
    const marker = workspaceJournal.head()
    await executor(toolSet, 'write_file')({ path: 'a.txt', content: 'changed' }, CALL)
    await executor(toolSet, 'write_file')({ path: 'new.txt', content: 'fresh' }, CALL)
    const plan = workspaceJournal.planRestoreAt(marker)
    vi.spyOn(workspace, 'remove').mockRejectedValueOnce(new WorkspacePermissionError())

    const error = await applyRestore(workspaceJournal, workspace, plan.changes, {
      checkConflicts: true,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RestoreApplyError)
    expect(error).toMatchObject({ path: 'new.txt', outcome: { restored: ['a.txt'], removed: [] } })
    expect((error as RestoreApplyError).cause).toBeInstanceOf(WorkspacePermissionError)
    await expect(workspace.readFile('a.txt')).resolves.toBe('original')
    await expect(workspace.readFile('new.txt')).resolves.toBe('fresh')
  })
})
