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
  deleteAgentRunsForParent,
  deleteThread,
  listAgentRuns,
  listThreadSummaries,
  listThreads,
  loadThread,
  renameThread,
  saveThread,
  setThreadWorkspaceLabel,
  THREAD_ENVELOPE_VERSION,
} from './persistence'
import { defaultThreadConfig } from './types'
import type { AgentThreadMeta, ChatThread } from './types'

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

  it('round-trips the thread mode and leaves an absent one unset', async () => {
    await saveThread(thread('mode-1', { mode: 'god' }))
    await expect(loadThread('mode-1')).resolves.toMatchObject({ mode: 'god' })

    await saveThread(thread('mode-2'))
    const loaded = await loadThread('mode-2')
    expect(loaded?.mode).toBeUndefined()
  })

  it('drops an unrecognized mode on load', async () => {
    const raw = JSON.stringify({
      version: THREAD_ENVELOPE_VERSION,
      thread: { ...thread('mode-3'), mode: 'admin' },
    })
    const blob = await encryptRecord(raw, 'thread:mode-3')
    await db.threads.put({ id: 'mode-3', blob, updatedAt: Date.now() })
    const loaded = await loadThread('mode-3')
    expect(loaded?.mode).toBeUndefined()
  })

  it('keeps the mode through a config-panel-style save', async () => {
    const original = thread('mode-4', { mode: 'read_only' })
    await saveThread(original)
    const loaded = (await loadThread('mode-4')) as ChatThread
    const configSaved: ChatThread = {
      ...loaded,
      config: { ...loaded.config, systemInstruction: 'changed' },
    }
    await saveThread(configSaved)
    await expect(loadThread('mode-4')).resolves.toMatchObject({
      mode: 'read_only',
      config: { systemInstruction: 'changed' },
    })
  })

  it('round-trips a plan and omits an absent one', async () => {
    const plan = [{ id: 'p1', text: 'one', status: 'pending' as const }]
    await saveThread(thread('plan-1', { plan }))
    await expect(loadThread('plan-1')).resolves.toMatchObject({ plan })

    await saveThread(thread('plan-2'))
    const loaded = await loadThread('plan-2')
    expect(loaded?.plan).toBeUndefined()
  })

  it('rejects an invalid plan on load', async () => {
    const raw = JSON.stringify({
      version: THREAD_ENVELOPE_VERSION,
      thread: { ...thread('plan-3'), plan: [{ id: 'p1' }] },
    })
    const blob = await encryptRecord(raw, 'thread:plan-3')
    await db.threads.put({ id: 'plan-3', blob, updatedAt: Date.now() })
    await expect(loadThread('plan-3')).rejects.toThrow(/plan/)
  })

  it('keeps the plan through a config-panel-style save', async () => {
    const plan = [{ id: 'p1', text: 'one', status: 'pending' as const }]
    await saveThread(thread('plan-4', { plan }))
    const loaded = (await loadThread('plan-4')) as ChatThread
    await saveThread({ ...loaded, config: { ...loaded.config, systemInstruction: 'changed' } })
    await expect(loadThread('plan-4')).resolves.toMatchObject({ plan })
  })

  it('round-trips a thread and returns null for a missing id', async () => {
    const original = thread('t1')
    await createThread(original)
    await expect(loadThread('t1')).resolves.toEqual(original)
    await expect(loadThread('missing')).resolves.toBeNull()
  })

  it('lists id, title, and updatedAt, newest first, with no plaintext label', async () => {
    await saveThread(thread('a', { updatedAt: 1000 }))
    await saveThread(thread('b', { updatedAt: 2000 }))

    const list = await listThreads()
    expect(list).toEqual([
      { id: 'b', title: 'Thread b', updatedAt: 2000 },
      { id: 'a', title: 'Thread a', updatedAt: 1000 },
    ])
    expect(Object.keys(list[0])).toEqual(['id', 'title', 'updatedAt'])
  })

  it('round-trips an optional workspace label without a version bump', async () => {
    await saveThread(thread('w', { workspaceName: 'project-x' }))
    const list = await listThreads()
    expect(list[0]).toMatchObject({ id: 'w', workspaceName: 'project-x' })
  })

  it('skips a corrupt row and still lists the valid rows', async () => {
    await saveThread(thread('good-1', { updatedAt: 1000 }))
    await db.threads.put({
      id: 'bad',
      blob: { iv: new Uint8Array([0]), ciphertext: new Uint8Array([1, 2, 3]) },
      updatedAt: 2000,
    })
    await saveThread(thread('good-2', { updatedAt: 3000 }))

    const result = await listThreadSummaries()
    expect(result.failures).toBe(1)
    expect(result.locked).toBe(false)
    expect(result.summaries.map((summary) => summary.id)).toEqual(['good-2', 'good-1'])
  })

  it('returns a locked marker instead of throwing while locked', async () => {
    await saveThread(thread('locked'))
    keyring.clear()

    const result = await listThreadSummaries()
    expect(result.locked).toBe(true)
    expect(result.summaries).toEqual([])
  })

  it('renames a thread and keeps the new title on reload', async () => {
    await saveThread(thread('r', { title: 'Old' }))
    await renameThread('r', 'New title')
    await expect(loadThread('r')).resolves.toMatchObject({ title: 'New title' })
  })

  it('does not resurrect a deleted thread when patched after the delete', async () => {
    await saveThread(thread('gone'))
    await deleteThread('gone')
    await renameThread('gone', 'Zombie')
    await expect(loadThread('gone')).resolves.toBeNull()
    await expect(db.threads.get('gone')).resolves.toBeUndefined()
  })

  it('sets and clears the workspace label', async () => {
    await saveThread(thread('label'))
    await setThreadWorkspaceLabel('label', 'folder-name')
    await expect(loadThread('label')).resolves.toMatchObject({ workspaceName: 'folder-name' })
    await setThreadWorkspaceLabel('label', undefined)
    await expect(loadThread('label')).resolves.not.toHaveProperty('workspaceName')
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

  it('writes no plaintext title, workspace label, or message content', async () => {
    const titleMarker = 'PLAINTEXT_TITLE_9f2c4a'
    const labelMarker = 'PLAINTEXT_LABEL_1a7b3c'
    const bodyMarker = 'PLAINTEXT_BODY_55ee11'
    await saveThread(
      thread('e', {
        title: titleMarker,
        workspaceName: labelMarker,
        messages: [userMessage('e-m1', bodyMarker)],
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
    expect(haystack).not.toContain(titleMarker)
    expect(haystack).not.toContain(labelMarker)
    expect(haystack).not.toContain(bodyMarker)
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

function agentThread(id: string, parentThreadId: string, status: AgentThreadMeta['status'] = 'running'): ChatThread {
  return thread(id, {
    agent: { runId: id, parentThreadId, mode: 'editing', tier: 'medium', status },
  })
}

describe('agent run persistence', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    await db.threads.clear()
    keyring.install(await deriveKey('agent-password', KDF))
  })

  it('round-trips the agent metadata without a version bump', async () => {
    await saveThread(agentThread('run-1', 'parent-1'))
    const loaded = await loadThread('run-1')
    expect(loaded?.agent).toEqual({
      runId: 'run-1',
      parentThreadId: 'parent-1',
      mode: 'editing',
      tier: 'medium',
      status: 'running',
    })
  })

  it('keeps a stopped run reason through a reload', async () => {
    await saveThread(
      thread('run-stop', {
        agent: {
          runId: 'run-stop',
          parentThreadId: 'parent-1',
          mode: 'editing',
          tier: 'medium',
          status: 'stopped',
          stopReason: 'user_stop',
        },
      }),
    )
    const loaded = await loadThread('run-stop')
    expect(loaded?.agent?.stopReason).toBe('user_stop')
  })

  it('keeps the continuation spec and profile through a reload', async () => {
    const spec = {
      mode: 'read_only' as const,
      toolNames: ['read_file', 'search'],
      profile: 'reviewer',
      skills: ['owasp'],
      allowTools: ['read_file'],
      outputSchema: { type: 'object' },
    }
    await saveThread(
      thread('run-spec', {
        agent: {
          runId: 'run-spec',
          parentThreadId: 'parent-1',
          profile: 'reviewer',
          mode: 'editing',
          tier: 'high',
          status: 'completed',
          spec,
        },
      }),
    )
    const loaded = await loadThread('run-spec')
    expect(loaded?.agent?.spec).toEqual(spec)
    expect(loaded?.agent?.profile).toBe('reviewer')
  })

  it('reads an older run without a spec, and drops a malformed spec instead of the run', async () => {
    await saveThread(agentThread('run-old', 'parent-1', 'completed'))
    await saveThread(
      thread('run-bad', {
        agent: {
          runId: 'run-bad',
          parentThreadId: 'parent-1',
          mode: 'editing',
          tier: 'medium',
          status: 'completed',
          spec: { mode: 'editing', toolNames: 'read_file' } as unknown as AgentThreadMeta['spec'],
        },
      }),
    )
    const old = await loadThread('run-old')
    const bad = await loadThread('run-bad')
    expect(old?.agent?.status).toBe('completed')
    expect(old?.agent?.spec).toBeUndefined()
    expect(bad?.agent?.status).toBe('completed')
    expect(bad?.agent?.spec).toBeUndefined()
  })

  it('excludes child runs from the conversations list', async () => {
    await saveThread(thread('parent-1', { updatedAt: 1000 }))
    await saveThread(agentThread('run-1', 'parent-1', 'completed'))

    const conversations = await listThreads()
    expect(conversations.map((entry) => entry.id)).toEqual(['parent-1'])
  })

  it('lists child runs by parent and newest first', async () => {
    await saveThread(agentThread('run-a', 'parent-1'))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await saveThread(agentThread('run-b', 'parent-1'))
    await saveThread(agentThread('run-c', 'parent-2'))

    const runs = await listAgentRuns('parent-1')
    expect(runs.map((run) => run.id)).toEqual(['run-b', 'run-a'])
    expect((await listAgentRuns()).map((run) => run.id).sort()).toEqual(['run-a', 'run-b', 'run-c'])
  })

  it('reconciles a persisted running child to interrupted on load', async () => {
    await saveThread(agentThread('run-1', 'parent-1', 'running'))
    const runs = await listAgentRuns('parent-1')
    expect(runs[0].agent?.status).toBe('interrupted')
  })

  it('cascades a delete to child runs', async () => {
    await saveThread(agentThread('run-1', 'parent-1'))
    await saveThread(agentThread('run-2', 'parent-1'))
    await saveThread(agentThread('run-3', 'parent-2'))

    await deleteAgentRunsForParent('parent-1')
    expect((await listAgentRuns('parent-1')).map((run) => run.id)).toEqual([])
    expect((await listAgentRuns('parent-2')).map((run) => run.id)).toEqual(['run-3'])
  })
})
