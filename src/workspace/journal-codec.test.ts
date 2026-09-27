import { describe, expect, it } from 'vitest'
import { decodeJournal, encodeJournal } from './journal-codec'
import type { JournalSnapshot } from './journal'

const state: JournalSnapshot = {
  seq: 7,
  entries: [
    { seq: 1, time: 1, kind: 'write', path: 'a.txt', before: null, after: 'hello' },
    { seq: 7, time: 2, kind: 'edit', path: 'a.txt', before: 'hello', after: 'bye' },
  ],
  checkpoints: [{ id: 'cp-3', seq: 3, time: 3, label: 'mark' }],
}

describe('journal codec', () => {
  it('round-trips a snapshot through gzip', async () => {
    const encoded = await encodeJournal(state)
    expect(encoded.length).toBeGreaterThan(0)
    await expect(decodeJournal(encoded)).resolves.toEqual(state)
  })

  it('round-trips a plain JSON payload', async () => {
    const plain = JSON.stringify({ version: 1, journal: state })
    await expect(decodeJournal(plain)).resolves.toEqual(state)
  })

  it('returns null for corrupt or future-version payloads', async () => {
    await expect(decodeJournal('not json')).resolves.toBeNull()
    await expect(decodeJournal('gz:not-base64')).resolves.toBeNull()
    await expect(
      decodeJournal(JSON.stringify({ version: 99, journal: state })),
    ).resolves.toBeNull()
    await expect(decodeJournal(JSON.stringify({ version: 1 }))).resolves.toBeNull()
  })

  it('keeps a child run\'s attribution through a save and reads an older journal without it', async () => {
    const attributed: JournalSnapshot = {
      seq: 2,
      entries: [
        { seq: 1, time: 1, kind: 'write', path: 'a.txt', before: null, after: 'x', runId: 'run-1' },
        { seq: 2, time: 2, kind: 'write', path: 'b.txt', before: null, after: 'y' },
      ],
      checkpoints: [],
    }
    const decoded = await decodeJournal(await encodeJournal(attributed))
    expect(decoded?.entries[0].runId).toBe('run-1')
    expect(decoded?.entries[1].runId).toBeUndefined()
    await expect(decodeJournal(await encodeJournal(state))).resolves.toEqual(state)
  })
})
