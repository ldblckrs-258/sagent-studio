import { beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { encryptRecord } from '../vault/records'
import { useVaultStore, vaultInternals } from '../vault/store'
import {
  createThread,
  deleteThread,
  listThreads,
  loadThread,
  saveThread,
  THREAD_ENVELOPE_VERSION,
} from './persistence'
import { defaultThreadConfig } from './types'
import type { ChatThread } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  const now = Date.now()
  return {
    id,
    title: `Thread ${id}`,
    messages: [userMessage(`${id}-m1`, `hello ${id}`)],
    config: defaultThreadConfig('provider-1', 'model-1'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('thread persistence', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    await db.threads.clear()
    keyring.install(await deriveKey('persist-password', KDF))
  })

  it('round-trips a thread and returns null for a missing id', async () => {
    const original = thread('t1')
    await createThread(original)
    await expect(loadThread('t1')).resolves.toEqual(original)
    await expect(loadThread('missing')).resolves.toBeNull()
  })

  it('lists only id and updatedAt, newest first', async () => {
    await saveThread(thread('a', { updatedAt: 1000 }))
    await saveThread(thread('b', { updatedAt: 2000 }))

    const list = await listThreads()
    expect(list).toEqual([
      { id: 'b', updatedAt: 2000 },
      { id: 'a', updatedAt: 1000 },
    ])
    expect(Object.keys(list[0])).toEqual(['id', 'updatedAt'])
  })

  it('serializes concurrent saves in enqueue order so the newest turn wins', async () => {
    const first = thread('c', { updatedAt: 1, title: 'first' })
    const second = thread('c', { updatedAt: 2, title: 'second' })
    await Promise.all([saveThread(first), saveThread(second)])

    await expect(loadThread('c')).resolves.toMatchObject({ title: 'second' })
    await expect(db.threads.get('c')).resolves.toMatchObject({ updatedAt: 2 })
  })

  it('lets no thread row land after lock resolves', async () => {
    const pending = thread('d')
    const save = saveThread(pending)
    const lock = useVaultStore.getState().lock()
    await Promise.allSettled([save, lock])

    await expect(db.threads.get('d')).resolves.toBeUndefined()
    expect(useVaultStore.getState().status).toBe('locked')
  })

  it('writes no plaintext title or message content', async () => {
    const marker = 'PLAINTEXT_MARKER_9f2c4a'
    await saveThread(
      thread('e', {
        title: marker,
        messages: [userMessage('e-m1', marker)],
      }),
    )

    const chunks: Uint8Array[] = []
    const collect = (value: unknown): void => {
      if (value instanceof Uint8Array) {
        chunks.push(value)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) collect(item)
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value as Record<string, unknown>)) collect(nested)
      }
    }
    for (const record of await db.threads.toArray()) collect(record)

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const haystack = new TextDecoder('utf-8', { fatal: false }).decode(merged)
    expect(chunks.length).toBeGreaterThan(0)
    expect(haystack).not.toContain(marker)
  })

  it('rejects a newer envelope version', async () => {
    const original = thread('f')
    const blob = await encryptRecord(
      JSON.stringify({ version: THREAD_ENVELOPE_VERSION + 1, thread: original }),
      'thread:f',
    )
    await db.threads.put({ id: 'f', blob, updatedAt: original.updatedAt })

    await expect(loadThread('f')).rejects.toThrow(/newer/)
  })

  it('rejects a read while the vault is locked', async () => {
    await saveThread(thread('g'))
    keyring.clear()
    await expect(loadThread('g')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('deletes a thread', async () => {
    await saveThread(thread('h'))
    await deleteThread('h')
    await expect(loadThread('h')).resolves.toBeNull()
  })
})
