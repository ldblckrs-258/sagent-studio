import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { defaultSettings, deepMerge } from '../vault/settings'
import { vaultInternals } from '../vault/store'
import { listThreads, loadThread } from './persistence'
import type { ThreadSummary } from './persistence'
import {
  createConversation,
  defaultProviderFor,
  deleteConversation,
  groupConversations,
  normalizeTitle,
  patchThreadMode,
  renameConversation,
} from './threads'
import { defaultThreadConfig } from './types'
import { saveThread } from './persistence'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function summary(
  id: string,
  updatedAt: number,
  workspaceName?: string,
): ThreadSummary {
  return workspaceName === undefined
    ? { id, title: `Thread ${id}`, updatedAt }
    : { id, title: `Thread ${id}`, workspaceName, updatedAt }
}

describe('conversation helpers', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    await db.threads.clear()
    keyring.install(await deriveKey('threads-password', KDF))
  })

  it('defaults a new conversation to editing and patches the mode', async () => {
    const created = await createConversation({ config: defaultThreadConfig('p1', 'm1') })
    expect(created.mode).toBe('editing')
    const patched = patchThreadMode({ ...created, updatedAt: 1 }, 'god')
    expect(patched.mode).toBe('god')
    expect(patched.updatedAt).toBeGreaterThan(1)
  })

  it('creates a conversation and lists its title and workspace label', async () => {
    const created = await createConversation({
      title: 'First',
      config: defaultThreadConfig('p1', 'm1'),
      workspaceName: 'proj',
    })
    expect(created.title).toBe('First')

    const list = await listThreads()
    expect(list).toEqual([
      expect.objectContaining({ id: created.id, title: 'First', workspaceName: 'proj' }),
    ])
  })

  it('never lets a rename revert after an engine persist', async () => {
    const created = await createConversation({
      config: defaultThreadConfig('p1', 'm1'),
    })
    // Store-first call site: update the in-memory thread, then persist the patch.
    const storeFirst = { ...created, title: 'Renamed' }
    await renameConversation(created.id, 'Renamed')
    // The engine's next persist writes the (already-updated) store object.
    await saveThread(storeFirst)

    await expect(loadThread(created.id)).resolves.toMatchObject({ title: 'Renamed' })
  })

  it('does not resurrect a deleted conversation on a late rename', async () => {
    const created = await createConversation({ config: defaultThreadConfig('p1', 'm1') })
    await deleteConversation(created.id)
    await renameConversation(created.id, 'Zombie')
    await expect(loadThread(created.id)).resolves.toBeNull()
  })

  it('deletes a conversation', async () => {
    const created = await createConversation({ config: defaultThreadConfig('p1', 'm1') })
    await deleteConversation(created.id)
    await expect(listThreads()).resolves.toEqual([])
  })

  it('normalizes an empty title to the default', () => {
    expect(normalizeTitle('   ')).toBe('New chat')
    expect(normalizeTitle('  hello  ')).toBe('hello')
    expect(normalizeTitle('x'.repeat(200)).length).toBe(80)
  })

  it('returns the first configured provider with its default model', () => {
    expect(defaultProviderFor(null)).toBeNull()
    const settings = deepMerge(defaultSettings(), {
      providers: [
        { id: 'p1', label: 'One', kind: 'openai-compatible', baseURL: '', apiKey: '', models: ['m1', 'm2'], defaultModel: 'm2' },
        { id: 'p2', label: 'Two', kind: 'openai-compatible', baseURL: '', apiKey: '', models: ['m3'], defaultModel: 'm3' },
      ],
    })
    expect(defaultProviderFor(settings)).toEqual({ providerId: 'p1', modelId: 'm2' })
    expect(defaultProviderFor(defaultSettings())).toBeNull()
  })
})

describe('groupConversations', () => {
  it('sorts named workspace groups alphabetically and the null group last', () => {
    const groups = groupConversations([
      summary('a', 10, 'zeta'),
      summary('b', 20),
      summary('c', 30, 'alpha'),
      summary('d', 5, 'alpha'),
    ])

    expect(groups.map((group) => group.workspaceName)).toEqual(['alpha', 'zeta', null])
    expect(groups[0].threads.map((thread) => thread.id)).toEqual(['c', 'd'])
    expect(groups[1].threads.map((thread) => thread.id)).toEqual(['a'])
    expect(groups[2].threads.map((thread) => thread.id)).toEqual(['b'])
  })

  it('returns an empty list for no summaries', () => {
    expect(groupConversations([])).toEqual([])
  })
})
