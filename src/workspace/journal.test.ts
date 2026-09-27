import { describe, expect, it } from 'vitest'
import { MAX_TOTAL_SNAPSHOT_CHARS, createWorkspaceJournal } from './journal'

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

  it('evicts the oldest snapshots past the byte budget', () => {
    const journal = createWorkspaceJournal()
    const chunk = 'x'.repeat(250_000)
    for (let index = 0; index < 40; index += 1) {
      journal.record({ kind: 'write', path: `f${index}.txt`, before: null, after: chunk })
    }
    const state = journal.snapshotState()
    const total = state.entries.reduce(
      (sum, entry) => sum + (entry.before?.length ?? 0) + (entry.after?.length ?? 0),
      0,
    )
    expect(state.entries.length).toBeLessThan(40)
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_SNAPSHOT_CHARS)
  })

  it('round-trips through snapshotState and restoreState', () => {
    const journal = createWorkspaceJournal()
    const checkpoint = journal.checkpoint('mark')
    journal.record({ kind: 'edit', path: 'a.txt', before: 'old', after: 'new' })

    const revived = createWorkspaceJournal()
    revived.restoreState(journal.snapshotState())

    expect(revived.checkpoints()[0].id).toBe(checkpoint.id)
    expect(revived.planRestore(checkpoint.id)?.changes).toEqual([
      { path: 'a.txt', content: 'old' },
    ])
  })
})

describe('workspace journal seq restore', () => {
  const withoutExpected = (changes: Array<{ path: string; content: string | null }>) =>
    changes.map(({ path, content }) => ({ path, content }))

  it('plans the same restore from a seq marker as from a checkpoint at that point', () => {
    const journal = createWorkspaceJournal()
    journal.record({ kind: 'write', path: 'a.txt', before: null, after: 'v1' })
    const marker = journal.head()
    const checkpoint = journal.checkpoint()
    journal.record({ kind: 'edit', path: 'a.txt', before: 'v1', after: 'v2' })
    journal.record({ kind: 'write', path: 'new.txt', before: null, after: 'fresh' })
    journal.record({ kind: 'edit', path: 'big.txt', before: 'x'.repeat(300_000), after: 'y' })

    const byCheckpoint = journal.planRestore(checkpoint.id)
    const bySeq = journal.planRestoreAt(marker)

    expect(bySeq.expired).toBeUndefined()
    expect(withoutExpected(bySeq.changes)).toEqual(byCheckpoint?.changes)
    expect(bySeq.changes).toEqual([
      { path: 'a.txt', content: 'v1', expected: 'v2' },
      { path: 'new.txt', content: null, expected: 'fresh' },
    ])
    expect(bySeq.unrestorable).toEqual(byCheckpoint?.unrestorable)
    expect(bySeq.unrestorable).toEqual(['big.txt'])
  })

  it('restores the content on disk when the marker was set, keeping an unjournaled edit made before it', () => {
    const journal = createWorkspaceJournal()
    journal.record({ kind: 'write', path: 'a.txt', before: null, after: 'agent' })
    const marker = journal.head()
    const checkpoint = journal.checkpoint()
    journal.record({ kind: 'write', path: 'a.txt', before: 'hand edit', after: 'later' })

    expect(journal.planRestoreAt(marker).changes).toEqual([
      { path: 'a.txt', content: 'hand edit', expected: 'later' },
    ])
    expect(journal.planRestore(checkpoint.id)?.changes).toEqual([{ path: 'a.txt', content: 'agent' }])
  })

  it('does not plan a path whose changes all predate the marker', () => {
    const journal = createWorkspaceJournal()
    journal.record({ kind: 'write', path: 'old.txt', before: null, after: 'kept' })
    const marker = journal.head()
    journal.record({ kind: 'write', path: 'new.txt', before: null, after: 'fresh' })

    expect(journal.planRestoreAt(marker).changes.map((change) => change.path)).toEqual(['new.txt'])
  })

  it('expires a marker ahead of the journal head, as after a journal reset', () => {
    const journal = createWorkspaceJournal()
    journal.record({ kind: 'write', path: 'a.txt', before: null, after: 'x' })
    const marker = journal.head()
    journal.clear()

    expect(journal.planRestoreAt(marker)).toMatchObject({ expired: true, changes: [] })
  })

  it('expires a marker only once entries after it were evicted', () => {
    const journal = createWorkspaceJournal()
    const first = journal.head()
    for (let index = 0; index < 600; index += 1) {
      journal.record({ kind: 'write', path: `f${index}.txt`, before: null, after: 'x' })
    }
    const oldest = journal.snapshotState().entries[0].seq

    expect(journal.planRestoreAt(first)).toMatchObject({ expired: true, changes: [] })
    expect(journal.planRestoreAt(oldest - 2).expired).toBe(true)
    const edge = journal.planRestoreAt(oldest - 1)
    expect(edge.expired).toBeUndefined()
    expect(edge.changes).toHaveLength(500)
  })

  it('expects the latest journaled content, and nothing when it was too large to keep', () => {
    const journal = createWorkspaceJournal()
    const marker = journal.head()
    journal.record({ kind: 'edit', path: 'a.txt', before: 'v0', after: 'v1' })
    journal.record({ kind: 'edit', path: 'a.txt', before: 'v1', after: 'v2' })
    journal.record({ kind: 'edit', path: 'b.txt', before: 'small', after: 'medium' })
    journal.record({ kind: 'edit', path: 'b.txt', before: 'medium', after: 'x'.repeat(300_000) })

    const [a, b] = journal.planRestoreAt(marker).changes
    expect(a).toEqual({ path: 'a.txt', content: 'v0', expected: 'v2' })
    expect(b).toEqual({ path: 'b.txt', content: 'small' })
    expect(b).not.toHaveProperty('expected')
  })
})
