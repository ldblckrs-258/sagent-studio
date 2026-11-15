import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { PlaygroundError } from './errors'
import type { PlaygroundProvider } from './provider'
import { createPlaygroundStore } from './state'
import { listRunMeta, playgroundPersistence } from './store'
import type { RunMeta } from './store'
import type { FormField, PlaygroundModel, ProviderRun } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function installKey(): Promise<void> {
  keyring.install(await deriveKey('playground-password', KDF))
}

const fields: FormField[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', multiline: true, required: true, nullable: false, secret: false },
  { name: 'input_image', label: 'Input image', kind: 'image', required: false, nullable: true, secret: false },
  { name: 'api_key', label: 'API key', kind: 'text', multiline: false, required: false, nullable: false, secret: true },
]

const model: PlaygroundModel = {
  providerId: 'replicate',
  slug: 'owner/name',
  label: 'owner/name',
  fields,
  editsImages: true,
  ref: { isOfficial: true, versionId: 'v1' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeProvider(polls: ProviderRun['status'][], options: { startGate?: Promise<void> } = {}) {
  const queue = [...polls]
  const provider = {
    id: 'replicate' as const,
    retentionMs: 55 * 60_000,
    verify: vi.fn(async () => ({ account: 'me' })),
    getModel: vi.fn(async () => model),
    prepareImage: vi.fn(async () => 'data:image/png;base64,AA'),
    start: vi.fn(async (): Promise<ProviderRun> => {
      await options.startGate
      return { providerRunId: 'pred-1', status: 'starting' }
    }),
    poll: vi.fn(async (): Promise<ProviderRun> => {
      const status = queue.length > 1 ? queue.shift()! : queue[0]
      return status === 'succeeded'
        ? { providerRunId: 'pred-1', status, outputs: [{ url: 'https://replicate.delivery/a/out.png' }], predictTime: 2 }
        : status === 'failed'
          ? { providerRunId: 'pred-1', status, error: 'CUDA out of memory' }
          : { providerRunId: 'pred-1', status }
    }),
    cancel: vi.fn(async () => {
      queue.splice(0, queue.length, 'canceled')
    }),
    download: vi.fn(async () => ({ blob: new Blob(['png-bytes'], { type: 'image/png' }), mime: 'image/png' })),
  }
  return provider satisfies PlaygroundProvider
}

function request(provider: PlaygroundProvider, input: Record<string, unknown> = { prompt: 'a cat' }) {
  return { provider, model, input, fields, inputImages: [] }
}

function runOf(store: ReturnType<typeof createPlaygroundStore>, id: string): RunMeta | undefined {
  return store.getState().runs.find((run) => run.id === id)
}

describe('playground run lifecycle', () => {
  beforeEach(async () => {
    await db.playgroundRuns.clear()
    await db.playgroundImages.clear()
    keyring.reset()
    await installKey()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves the provider id before polling, then stores the outputs once the run succeeds', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    await store.getState().hydrate(() => null)
    const provider = fakeProvider(['processing', 'succeeded'])
    const savedBeforePoll: (string | undefined)[] = []
    provider.poll.mockImplementationOnce(async () => {
      savedBeforePoll.push((await listRunMeta()).runs[0]?.providerRunId)
      return { providerRunId: 'pred-1', status: 'processing' }
    })
    const id = await store.getState().start(request(provider))
    expect(runOf(store, id)?.status).toBe('starting')
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('succeeded'))
    expect(savedBeforePoll).toEqual(['pred-1'])
    const stored = (await listRunMeta()).runs[0]
    expect(stored).toMatchObject({ status: 'succeeded', outputs: [{ index: 0, mime: 'image/png', size: 9 }], predictTime: 2 })
    expect(store.getState().active[id]).toBeUndefined()
    const blob = await store.getState().loadImageBlob(`${id}:output:0`, 'image/png')
    expect(await blob.text()).toBe('png-bytes')
  })

  it('stores the provider error when the prediction fails', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(fakeProvider(['failed'])))
    await vi.waitFor(() => expect(runOf(store, id)).toMatchObject({ status: 'failed', error: 'CUDA out of memory' }))
  })

  it('stores a start rejection such as a 422 on the run instead of losing it', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const provider = fakeProvider(['processing'])
    provider.start.mockRejectedValueOnce(new Error('- input: prompt is required'))
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)).toMatchObject({ status: 'failed', error: '- input: prompt is required' }))
  })

  it('never stores secret fields and keeps uploaded images as references', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const provider = fakeProvider(['succeeded'])
    await store.getState().start({
      ...request(provider, { prompt: 'edit', input_image: 'data:image/png;base64,AAAA', api_key: 'sk-secret-value' }),
      inputImages: [{ field: 'input_image', name: 'cat.png', blob: new Blob(['cat'], { type: 'image/png' }) }],
    })
    const stored = (await listRunMeta()).runs[0]
    expect(stored.input).toEqual({ prompt: 'edit', input_image: { $image: 0 } })
    expect(stored.secretFields).toEqual(['api_key'])
    expect(JSON.stringify(stored)).not.toContain('sk-secret-value')
    expect(provider.start).toHaveBeenCalledWith(model, expect.objectContaining({ api_key: 'sk-secret-value' }), expect.anything())
  })

  it('cancels as soon as the id is known when Cancel was pressed before the provider answered', async () => {
    const gate = deferred<void>()
    const provider = fakeProvider(['processing'], { startGate: gate.promise })
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await store.getState().cancel(id)
    expect(store.getState().active[id]?.cancelRequested).toBe(true)
    expect(provider.cancel).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(provider.cancel).toHaveBeenCalledWith('pred-1'))
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('canceled'))
  })

  it('marks a run canceled only after the provider reports it', async () => {
    const provider = fakeProvider(['processing'])
    provider.cancel.mockImplementation(async () => undefined)
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.providerRunId).toBe('pred-1'))
    await store.getState().cancel(id)
    expect(provider.cancel).toHaveBeenCalledWith('pred-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runOf(store, id)?.status).not.toBe('canceled')
    provider.poll.mockResolvedValue({ providerRunId: 'pred-1', status: 'canceled' })
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('canceled'))
  })

  it('stops quietly on lock and resumes after unlock within the retention window', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const provider = fakeProvider(['processing'])
    const locked = deferred<void>()
    provider.poll.mockImplementation(async () => {
      if (keyring.getKey()) {
        keyring.clear()
        locked.resolve()
      }
      return { providerRunId: 'pred-1', status: 'processing' }
    })
    const update = vi.spyOn(playgroundPersistence, 'update')
    const id = await store.getState().start(request(provider))
    await locked.promise
    const writes = update.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(update.mock.calls.length).toBe(writes)
    expect(provider.poll).toHaveBeenCalledTimes(1)

    store.getState().clear()
    await installKey()
    provider.poll.mockReset()
    provider.poll.mockResolvedValue({
      providerRunId: 'pred-1',
      status: 'succeeded',
      outputs: [{ url: 'https://replicate.delivery/a/out.png' }],
    })
    await store.getState().hydrate(() => provider)
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('succeeded'))
    expect((await listRunMeta()).runs[0].outputs).toHaveLength(1)
  })

  it('marks an old unfinished run expired and one never accepted by the provider interrupted', async () => {
    let clock = 1_000_000
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1, now: () => clock })
    const base = {
      providerId: 'replicate' as const,
      model: 'owner/name',
      modelLabel: 'owner/name',
      input: {},
      secretFields: [],
      inputImages: [],
      outputs: [],
      bytes: 0,
      createdAt: clock,
    }
    await playgroundPersistence.create({ ...base, id: 'old', status: 'processing', providerRunId: 'p-old' }, [], [])
    await playgroundPersistence.create({ ...base, id: 'never', status: 'starting' }, [], [])
    clock += 56 * 60_000
    const provider = fakeProvider(['processing'])
    await store.getState().hydrate(() => provider)
    expect(runOf(store, 'old')?.status).toBe('expired')
    expect(runOf(store, 'never')?.status).toBe('interrupted')
    expect(provider.poll).not.toHaveBeenCalled()
  })

  it('clears cached models and revokes object URLs when the session ends', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const provider = fakeProvider(['succeeded'])
    await store.getState().resolveModel(provider, 'owner/name')
    await store.getState().resolveModel(provider, 'owner/name')
    expect(provider.getModel).toHaveBeenCalledTimes(1)
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('succeeded'))
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const url = await store.getState().imageUrl(`${id}:output:0`, 'image/png')
    expect(url).toMatch(/^blob:/)
    store.getState().clear()
    expect(revoke).toHaveBeenCalledWith(url)
    expect(store.getState().models).toEqual({})
    expect(store.getState().runs).toEqual([])
  })

  it('revokes an image URL when its last card releases it', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(fakeProvider(['succeeded'])))
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('succeeded'))
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const image = `${id}:output:0`
    const first = await store.getState().imageUrl(image, 'image/png')
    expect(await store.getState().imageUrl(image, 'image/png')).toBe(first)
    store.getState().releaseImageUrl(image)
    expect(revoke).not.toHaveBeenCalled()
    store.getState().releaseImageUrl(image)
    expect(revoke).toHaveBeenCalledWith(first)
  })

  it('removes a run and its images, and stops following it', async () => {
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const provider = fakeProvider(['processing'])
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.providerRunId).toBe('pred-1'))
    await store.getState().remove(id)
    expect(store.getState().runs).toEqual([])
    expect(store.getState().active).toEqual({})
    expect(provider.cancel).toHaveBeenCalledWith('pred-1')
    expect(await db.playgroundRuns.count()).toBe(0)
  })

  it('cancels the prediction when the run is deleted before the provider returned its id, so nothing runs unbilled-for', async () => {
    const gate = deferred<void>()
    const provider = fakeProvider(['processing'], { startGate: gate.promise })
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await store.getState().remove(id)
    gate.resolve()
    await vi.waitFor(() => expect(provider.cancel).toHaveBeenCalledWith('pred-1'))
    expect(provider.poll).not.toHaveBeenCalled()
  })

  it('cancels the prediction when the vault locks before its id could be stored', async () => {
    const gate = deferred<void>()
    const provider = fakeProvider(['processing'], { startGate: gate.promise })
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    await store.getState().start(request(provider))
    keyring.clear()
    gate.resolve()
    await vi.waitFor(() => expect(provider.cancel).toHaveBeenCalledWith('pred-1'))
  })

  it('keeps following a run through a transient poll failure instead of marking it failed', async () => {
    const provider = fakeProvider(['succeeded'])
    provider.poll.mockRejectedValueOnce(new PlaygroundError('network', 'offline'))
    provider.poll.mockRejectedValueOnce(new PlaygroundError('http', 'bad gateway', { status: 502 }))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.status).toBe('succeeded'))
    expect(provider.poll).toHaveBeenCalledTimes(3)
  })

  it('still fails a run on a permanent poll error', async () => {
    const provider = fakeProvider(['processing'])
    provider.poll.mockRejectedValueOnce(new PlaygroundError('unauthorized', 'The provider rejected the token.', { status: 401 }))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)).toMatchObject({ status: 'failed', error: 'The provider rejected the token.' }))
  })

  it('lets a failed hydrate be retried without locking first', async () => {
    const list = vi.spyOn(playgroundPersistence, 'list').mockRejectedValueOnce(new Error('disk hiccup'))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    await store.getState().hydrate(() => null)
    expect(store.getState()).toMatchObject({ hydrated: false, error: 'disk hiccup' })
    await store.getState().hydrate(() => null)
    expect(store.getState()).toMatchObject({ hydrated: true, error: null })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('resumes the other unfinished runs when one of them cannot be saved', async () => {
    const base = {
      providerId: 'replicate' as const,
      model: 'owner/name',
      modelLabel: 'owner/name',
      input: {},
      secretFields: [],
      inputImages: [],
      outputs: [],
      bytes: 0,
      createdAt: Date.now(),
    }
    await playgroundPersistence.create({ ...base, id: 'never', status: 'starting', createdAt: base.createdAt + 1 }, [], [])
    await playgroundPersistence.create({ ...base, id: 'live', status: 'processing', providerRunId: 'pred-1' }, [], [])
    const update = vi.spyOn(playgroundPersistence, 'update')
    update.mockRejectedValueOnce(new Error('write failed'))
    const provider = fakeProvider(['succeeded'])
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    await store.getState().hydrate(() => provider)
    await vi.waitFor(() => expect(runOf(store, 'live')?.status).toBe('succeeded'))
  })

  it('re-fetches fresh output links and stores the images when a failed download is retried', async () => {
    const provider = fakeProvider(['succeeded'])
    provider.download.mockRejectedValueOnce(new PlaygroundError('network', 'The file host could not be reached (HTTP 502).'))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)).toMatchObject({ status: 'succeeded', outputs: [] }))
    expect(runOf(store, id)?.error).toContain('could not be reached')
    const polls = provider.poll.mock.calls.length

    await store.getState().retryDownload(id, provider)
    await vi.waitFor(() => expect(runOf(store, id)?.outputs).toHaveLength(1))
    expect(runOf(store, id)?.error).toBeUndefined()
    expect(runOf(store, id)?.status).toBe('succeeded')
    expect(provider.poll.mock.calls.length).toBe(polls + 1)
    expect((await listRunMeta()).runs[0].outputs).toHaveLength(1)
  })

  it('keeps the run succeeded when a retried download fails again', async () => {
    const provider = fakeProvider(['succeeded'])
    provider.download.mockRejectedValue(new PlaygroundError('network', 'still blocked'))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1 })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.error).toBe('still blocked'))
    await store.getState().retryDownload(id, provider)
    await vi.waitFor(() => expect(store.getState().active[id]).toBeUndefined())
    expect(runOf(store, id)).toMatchObject({ status: 'succeeded', outputs: [], error: 'still blocked' })
  })

  it('refuses to retry a download after the provider has removed the output', async () => {
    let clock = 1_000_000
    const provider = fakeProvider(['succeeded'])
    provider.download.mockRejectedValueOnce(new PlaygroundError('network', 'blocked'))
    const store = createPlaygroundStore(playgroundPersistence, { pollMs: 1, now: () => clock })
    const id = await store.getState().start(request(provider))
    await vi.waitFor(() => expect(runOf(store, id)?.error).toBe('blocked'))
    clock += 56 * 60_000
    await expect(store.getState().retryDownload(id, provider)).rejects.toMatchObject({ code: 'not_found' })
  })
})

