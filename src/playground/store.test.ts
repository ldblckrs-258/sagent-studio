import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { VaultDatabase, db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { useVaultStore } from '../vault/store'
import {
  MAX_PLAYGROUND_BYTES,
  MAX_PLAYGROUND_RUNS,
  addOutputs,
  createRun,
  imageId,
  listRunMeta,
  loadImage,
  pruneFor,
  removeRuns,
  updateRun,
} from './store'
import type { RunMeta } from './store'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }
const PROMPT = 'PROMPT_MARKER_93ab1c'
const IMAGE_MARKER = 'IMAGE_BYTES_MARKER_55d0'

async function installKey(password = 'playground-password'): Promise<void> {
  keyring.reset()
  keyring.install(await deriveKey(password, KDF))
}

function meta(patch: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'run-1',
    providerId: 'replicate',
    model: 'owner/name',
    modelLabel: 'owner/name',
    input: { prompt: PROMPT, input_image: { $image: 0 } },
    secretFields: [],
    inputImages: [{ field: 'input_image', index: 0, name: 'a.png', mime: 'image/png', size: IMAGE_MARKER.length }],
    outputs: [],
    status: 'starting',
    bytes: IMAGE_MARKER.length,
    createdAt: 1,
    ...patch,
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

describe('encrypted playground history', () => {
  beforeEach(async () => {
    await db.playgroundRuns.clear()
    await db.playgroundImages.clear()
    await db.fs.clear()
    await installKey()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores neither the prompt nor the image bytes in plaintext, and round-trips both', async () => {
    await createRun(meta(), [new Blob([IMAGE_MARKER], { type: 'image/png' })], [])
    const run = await db.playgroundRuns.get('run-1')
    const image = await db.playgroundImages.get(imageId('run-1', 'input', 0))
    expect(Object.keys(run ?? {}).sort()).toEqual(['blob', 'createdAt', 'id'])
    expect(Object.keys(image ?? {}).sort()).toEqual(['blob', 'id', 'runId'])
    const raw = `${JSON.stringify(run)}${text(run!.blob.ciphertext)}${JSON.stringify(image)}${text(image!.blob.ciphertext)}`
    expect(raw).not.toContain(PROMPT)
    expect(raw).not.toContain(IMAGE_MARKER)

    expect((await listRunMeta()).runs).toEqual([meta()])
    expect(text(await loadImage(imageId('run-1', 'input', 0)))).toBe(IMAGE_MARKER)
  })

  it('binds each row to its id, so a row copied under another id fails to open and is skipped', async () => {
    await createRun(meta(), [], [])
    const row = await db.playgroundRuns.get('run-1')
    await db.playgroundRuns.put({ ...row!, id: 'run-forged' })
    const listed = await listRunMeta()
    expect(listed.runs.map((run) => run.id)).toEqual(['run-1'])
    expect(listed.skipped).toBe(1)
  })

  it('lists runs without touching the image table, so opening Playground does not decrypt every image', async () => {
    await createRun(meta(), [new Blob([IMAGE_MARKER])], [])
    const toArray = vi.spyOn(db.playgroundImages, 'toArray')
    const get = vi.spyOn(db.playgroundImages, 'get')
    const where = vi.spyOn(db.playgroundImages, 'where')
    await listRunMeta()
    expect(toArray).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(where).not.toHaveBeenCalled()
  })

  it('does not resurrect a run that was deleted while its lifecycle was still writing', async () => {
    await createRun(meta(), [new Blob([IMAGE_MARKER])], [])
    await removeRuns(['run-1'])
    expect(await updateRun(meta({ status: 'processing' }))).toBe(false)
    expect(await addOutputs(meta({ status: 'succeeded' }), [new Blob(['out'])], [])).toBeNull()
    expect(await db.playgroundRuns.count()).toBe(0)
    expect(await db.playgroundImages.count()).toBe(0)
  })

  it('stores outputs with the final run in one write and prunes the oldest runs past the byte budget', async () => {
    const old = meta({ id: 'run-old', createdAt: 1, bytes: MAX_PLAYGROUND_BYTES - 10, status: 'failed' })
    await createRun(old, [new Blob(['x'])], [])
    const fresh = meta({ id: 'run-new', createdAt: 2, bytes: 5, inputImages: [], input: { prompt: 'p' } })
    await createRun(fresh, [], [old])
    const done = { ...fresh, status: 'succeeded' as const, bytes: 20, outputs: [{ index: 0, mime: 'image/png', size: 15 }] }
    const removed = await addOutputs(done, [new Blob(['fifteen-bytes!!'])], [old, fresh])
    expect(removed).toEqual(['run-old'])
    expect((await listRunMeta()).runs.map((run) => run.id)).toEqual(['run-new'])
    expect(await db.playgroundImages.where('runId').equals('run-old').count()).toBe(0)
    expect(text(await loadImage(imageId('run-new', 'output', 0)))).toBe('fifteen-bytes!!')
  })

  it('maps Dexie quota failures to a storage_full error the gallery can show', async () => {
    vi.spyOn(db.playgroundRuns, 'put').mockImplementation(() => {
      throw new Dexie.AbortError('aborted', new Dexie.QuotaExceededError('full'))
    })
    await expect(createRun(meta(), [], [])).rejects.toMatchObject({ code: 'storage_full' })
  })

  it('empties both tables and the Playground folder handle on recover', async () => {
    await createRun(meta(), [new Blob([IMAGE_MARKER])], [])
    await db.fs.put({ id: 'playground:folder', handle: {} as FileSystemDirectoryHandle, updatedAt: 1 })
    await useVaultStore.getState().recover()
    expect(await db.playgroundRuns.count()).toBe(0)
    expect(await db.playgroundImages.count()).toBe(0)
    expect(await db.fs.get('playground:folder')).toBeUndefined()
  })
})

describe('pruneFor', () => {
  const run = (id: string, createdAt: number, bytes = 1, status: RunMeta['status'] = 'succeeded') =>
    meta({ id, createdAt, bytes, status })

  it('keeps everything while under both limits', () => {
    expect(pruneFor(run('n', 10), [run('a', 1), run('b', 2)])).toEqual([])
  })

  it('removes the oldest runs past the count limit, whatever their status', () => {
    const existing = Array.from({ length: MAX_PLAYGROUND_RUNS }, (_, index) =>
      run(`r${index}`, index, 1, index === 0 ? 'canceled' : index === 1 ? 'processing' : 'succeeded'),
    )
    expect(pruneFor(run('n', 1000), existing)).toEqual(['r0'])
  })

  it('removes as many old runs as needed to fit the byte budget', () => {
    const half = MAX_PLAYGROUND_BYTES / 2
    expect(pruneFor(run('n', 10, half), [run('a', 1, half), run('b', 2, half)])).toEqual(['a'])
  })
})

describe('schema upgrade', () => {
  it('opens a v8 database with its data intact and empty playground tables', async () => {
    const name = `sagent-playground-upgrade-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(8).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
      journals: 'id, updatedAt',
      documents: 'id, updatedAt',
      chunks: 'id, docId, [docId+ordinal]',
      memories: 'id, updatedAt',
      mcpServers: 'id, updatedAt',
    })
    await legacy.open()
    await legacy.table('threads').put({ id: 't1', blob: { iv: 1 }, updatedAt: 1 })
    legacy.close()

    const upgraded = new VaultDatabase(name)
    await upgraded.open()
    expect(upgraded.verno).toBe(9)
    expect(await upgraded.threads.get('t1')).toEqual({ id: 't1', blob: { iv: 1 }, updatedAt: 1 })
    expect(await upgraded.playgroundRuns.count()).toBe(0)
    expect(await upgraded.playgroundImages.count()).toBe(0)
    upgraded.close()
    await Dexie.delete(name)
  })
})
