import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { createJournalStore } from './journal-store'

async function installKey(): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  keyring.install(key)
}

describe('journal store', () => {
  beforeEach(async () => {
    await installKey()
    await db.journals.clear()
  })

  afterEach(() => {
    keyring.clear()
  })

  it('persists a journal and reloads it into a fresh store', async () => {
    const first = createJournalStore()
    const journal = await first.forThread('t1')
    journal.record({ kind: 'write', path: 'a.txt', before: null, after: 'hello' })
    const checkpoint = journal.checkpoint('before edit')
    journal.record({ kind: 'edit', path: 'a.txt', before: 'hello', after: 'bye' })
    await first.flush('t1')

    const second = createJournalStore()
    const reloaded = await second.forThread('t1')
    expect(reloaded.planRestore(checkpoint.id)?.changes).toEqual([
      { path: 'a.txt', content: 'hello' },
    ])

    await second.remove('t1')
  })

  it('keeps journals isolated per thread and deletes on remove', async () => {
    const store = createJournalStore()
    const a = await store.forThread('a')
    const b = await store.forThread('b')
    a.record({ kind: 'write', path: 'x.txt', before: null, after: 'A' })
    b.record({ kind: 'write', path: 'x.txt', before: null, after: 'B' })
    await store.flushAll()

    expect(a.history('x.txt')).toHaveLength(1)
    expect(a.history('x.txt')[0].afterHash).not.toBe(b.history('x.txt')[0].afterHash)

    await store.remove('a')
    expect(await db.journals.get('a')).toBeUndefined()

    const reloaded = await createJournalStore().forThread('a')
    expect(reloaded.size()).toBe(0)

    await store.remove('b')
  })
})
