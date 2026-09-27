import { describe, expect, it } from 'vitest'
import type { WorkspaceApi } from '../tools/types'
import { WorkspaceNotFoundError } from './errors'
import { createWorkspaceJournal } from './journal'
import { applyRunRevert, tagJournal } from './run-journal'

function memoryWorkspace(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const workspace = {
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new WorkspaceNotFoundError(path)
      return text
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    remove: async (path: string) => {
      files.delete(path)
    },
  } as unknown as WorkspaceApi
  return { workspace, files }
}

describe('tagJournal', () => {
  it('attributes a child write to its run while the parent writes stay unattributed', () => {
    const journal = createWorkspaceJournal()
    const child = tagJournal(journal, 'run-1')

    child.record({ kind: 'write', path: 'a.ts', before: null, after: 'a' })
    journal.record({ kind: 'write', path: 'b.ts', before: null, after: 'b' })

    const [childEntry, parentEntry] = journal.snapshotState().entries
    expect(childEntry.runId).toBe('run-1')
    expect(parentEntry.runId).toBeUndefined()
  })
})

describe('changesForRun', () => {
  it('merges several edits to one path into the first before and the last after', () => {
    const journal = createWorkspaceJournal()
    const child = tagJournal(journal, 'run-1')
    child.record({ kind: 'write', path: 'a.ts', before: 'one\n', after: 'two\n' })
    child.record({ kind: 'edit', path: 'a.ts', before: 'two\n', after: 'three\nfour\n' })
    child.record({ kind: 'write', path: 'new.ts', before: null, after: 'x\n' })
    child.record({ kind: 'write', path: 'same.ts', before: 's', after: 't' })
    child.record({ kind: 'write', path: 'same.ts', before: 't', after: 's' })
    journal.record({ kind: 'write', path: 'parent.ts', before: null, after: 'p' })

    const changes = journal.changesForRun('run-1')

    expect(changes.map((change) => [change.path, change.kind])).toEqual([
      ['a.ts', 'modified'],
      ['new.ts', 'created'],
    ])
    expect(changes[0]).toMatchObject({ before: 'one\n', after: 'three\nfour\n', addedLines: 2, removedLines: 1 })
  })
})

describe('applyRunRevert', () => {
  it('restores the run\'s files, skips a file edited later, and reports a partial one', async () => {
    const { workspace, files } = memoryWorkspace({
      'a.ts': 'child a',
      'b.ts': 'parent b',
      'new.ts': 'created',
      'big.bin': 'huge',
    })
    const journal = createWorkspaceJournal()
    const child = tagJournal(journal, 'run-1')
    child.record({ kind: 'write', path: 'a.ts', before: 'original a', after: 'child a' })
    child.record({ kind: 'write', path: 'b.ts', before: 'original b', after: 'child b' })
    child.record({ kind: 'write', path: 'new.ts', before: null, after: 'created' })
    child.record({ kind: 'write', path: 'big.bin', before: null, after: null, partial: true })
    journal.record({ kind: 'edit', path: 'b.ts', before: 'child b', after: 'parent b' })

    const outcome = await applyRunRevert(workspace, journal, 'run-1', 'scout')

    expect(outcome.reverted.sort()).toEqual(['a.ts', 'new.ts'])
    expect(outcome.conflicts).toEqual(['b.ts'])
    expect(outcome.unrestorable).toEqual(['big.bin'])
    expect(files.get('a.ts')).toBe('original a')
    expect(files.has('new.ts')).toBe(false)
    expect(files.get('b.ts')).toBe('parent b')
  })

  it('skips a file whose content changed outside the journal since the run wrote it', async () => {
    const { workspace, files } = memoryWorkspace({ 'a.ts': 'edited in the editor' })
    const journal = createWorkspaceJournal()
    tagJournal(journal, 'run-1').record({ kind: 'write', path: 'a.ts', before: 'original', after: 'child' })

    const outcome = await applyRunRevert(workspace, journal, 'run-1', 'scout')

    expect(outcome.reverted).toEqual([])
    expect(outcome.conflicts).toEqual(['a.ts'])
    expect(files.get('a.ts')).toBe('edited in the editor')
  })

  it('records the revert as a restore so a checkpoint taken before it can undo it', async () => {
    const { workspace, files } = memoryWorkspace({ 'a.ts': 'child' })
    const journal = createWorkspaceJournal()
    tagJournal(journal, 'run-1').record({ kind: 'write', path: 'a.ts', before: 'original', after: 'child' })
    const checkpoint = journal.checkpoint('before revert')

    await applyRunRevert(workspace, journal, 'run-1', 'scout')

    const restore = journal.snapshotState().entries.at(-1)
    expect(restore).toMatchObject({ kind: 'restore', path: 'a.ts', before: 'child', after: 'original', label: 'revert run scout' })
    expect(restore?.runId).toBeUndefined()
    expect(journal.planRestore(checkpoint.id)?.changes).toEqual([{ path: 'a.ts', content: 'child' }])
    expect(files.get('a.ts')).toBe('original')
  })
})

describe('journal eviction', () => {
  it('marks a run expired once any of its entries fall out of the journal, and keeps that across a reload', async () => {
    const journal = createWorkspaceJournal()
    tagJournal(journal, 'run-1').record({ kind: 'write', path: 'a.ts', before: 'original', after: 'child' })
    for (let index = 0; index < 500; index += 1) {
      journal.record({ kind: 'write', path: `p${index}.ts`, before: null, after: 'p' })
    }
    const { workspace, files } = memoryWorkspace({ 'a.ts': 'child' })

    expect(journal.planRunRevert('run-1').expired).toBe(true)
    const outcome = await applyRunRevert(workspace, journal, 'run-1', 'scout')
    expect(outcome).toEqual({ reverted: [], conflicts: [], unrestorable: [], expired: true })
    expect(files.get('a.ts')).toBe('child')

    const reloaded = createWorkspaceJournal()
    reloaded.restoreState(journal.snapshotState())
    expect(reloaded.planRunRevert('run-1').expired).toBe(true)
  })
})
