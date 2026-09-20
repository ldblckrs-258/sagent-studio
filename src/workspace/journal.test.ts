import { describe, expect, it } from 'vitest'
import { createWorkspaceJournal } from './journal'

describe('workspace journal restore', () => {
  it('restores a pre-existing file to its state before the checkpoint', () => {
    const journal = createWorkspaceJournal()
    const checkpoint = journal.checkpoint()
    journal.record({ kind: 'edit', path: 'README.md', before: 'ORIGINAL', after: 'CHANGED' })

    const plan = journal.planRestore(checkpoint.id)
    expect(plan?.changes).toEqual([{ path: 'README.md', content: 'ORIGINAL' }])
    expect(journal.baseContentFor('README.md', checkpoint.id)).toBe('ORIGINAL')
  })

  it('removes a file genuinely created after the checkpoint', () => {
    const journal = createWorkspaceJournal()
    const checkpoint = journal.checkpoint()
    journal.record({ kind: 'write', path: 'new.txt', before: null, after: 'fresh' })

    expect(journal.planRestore(checkpoint.id)?.changes).toEqual([{ path: 'new.txt', content: null }])
  })

  it('marks a path unrestorable when its snapshot was too large to keep', () => {
    const journal = createWorkspaceJournal()
    const checkpoint = journal.checkpoint()
    journal.record({ kind: 'edit', path: 'big.txt', before: 'x'.repeat(300_000), after: 'y' })

    const plan = journal.planRestore(checkpoint.id)
    expect(plan?.changes).toEqual([])
    expect(plan?.unrestorable).toEqual(['big.txt'])
  })

  it('expires a checkpoint older than the retained window', () => {
    const journal = createWorkspaceJournal()
    const checkpoint = journal.checkpoint()
    for (let index = 0; index < 600; index += 1) {
      journal.record({ kind: 'write', path: `f${index}.txt`, before: null, after: 'x' })
    }
    const plan = journal.planRestore(checkpoint.id)
    expect(plan?.expired).toBe(true)
    expect(plan?.changes).toEqual([])
  })
})
