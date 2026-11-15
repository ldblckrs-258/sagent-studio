import { create } from 'zustand'
import { VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { PlaygroundError } from './errors'
import { storableInput } from './form'
import type { PlaygroundProvider } from './provider'
import { playgroundPersistence } from './store'
import type { ImageRef, OutputRef, PlaygroundPersistence, RunMeta } from './store'
import { isTerminal } from './types'
import type { FormField, PlaygroundModel, PlaygroundProviderId, ProviderRun } from './types'

export const POLL_INTERVAL_MS = 1500
export const MAX_POLL_BACKOFF_MS = 30_000
export const MAX_LIVE_IMAGE_URLS = 48

export interface InputImage {
  field: string
  name: string
  blob: Blob
}

export interface StartRequest {
  provider: PlaygroundProvider
  model: PlaygroundModel
  input: Record<string, unknown>
  fields: readonly FormField[]
  inputImages: readonly InputImage[]
}

export interface ActiveRun {
  cancelRequested: boolean
}

export type ProviderResolver = (id: PlaygroundProviderId) => PlaygroundProvider | null

export interface PlaygroundState {
  runs: RunMeta[]
  active: Record<string, ActiveRun>
  models: Record<string, PlaygroundModel>
  hydrated: boolean
  skipped: number
  error: string | null
  hydrate(resolve: ProviderResolver): Promise<void>
  resolveModel(provider: PlaygroundProvider, slug: string, signal?: AbortSignal): Promise<PlaygroundModel>
  start(request: StartRequest): Promise<string>
  cancel(runId: string): Promise<void>
  remove(runId: string): Promise<void>
  retryDownload(runId: string, provider: PlaygroundProvider): Promise<void>
  imageUrl(imageId: string, mime: string): Promise<string>
  releaseImageUrl(imageId: string): void
  loadImageBlob(imageId: string, mime: string): Promise<Blob>
  clear(): void
}

export interface PlaygroundStoreOptions {
  pollMs?: number
  now?: () => number
}

interface Stamp {
  key: number
  session: number
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof PlaygroundError)) return false
  return error.code === 'network' || error.code === 'rate_limited' || (error.code === 'http' && (error.status ?? 0) >= 500)
}

function newestFirst(a: RunMeta, b: RunMeta): number {
  return b.createdAt - a.createdAt
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function withImageRefs(
  stored: Record<string, unknown>,
  fields: readonly FormField[],
  images: readonly ImageRef[],
): Record<string, unknown> {
  const next = { ...stored }
  for (const field of fields) {
    const refs = images.filter((image) => image.field === field.name).map((image) => ({ $image: image.index }))
    if (refs.length === 0) continue
    if (field.kind === 'image') next[field.name] = refs[0]
    else if (field.kind === 'images') next[field.name] = refs
  }
  return next
}

export function createPlaygroundStore(persistence: PlaygroundPersistence, options: PlaygroundStoreOptions = {}) {
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS
  const now = options.now ?? Date.now

  return create<PlaygroundState>((set, get) => {
    let session = 0
    let hydrating: Promise<void> | null = null
    let tick = 0
    const live = new Map<string, { controller: AbortController; provider: PlaygroundProvider }>()
    const urls = new Map<string, { url: string; refs: number; used: number }>()
    const pendingUrls = new Map<string, Promise<string>>()

    function stamp(): Stamp {
      return { key: keyring.getGeneration(), session }
    }

    function isCurrent(at: Stamp): boolean {
      return at.key === keyring.getGeneration() && at.session === session
    }

    function revokeUrl(id: string): void {
      const entry = urls.get(id)
      if (!entry) return
      URL.revokeObjectURL(entry.url)
      urls.delete(id)
    }

    function trimUrls(): void {
      while (urls.size > MAX_LIVE_IMAGE_URLS) {
        let oldest: string | null = null
        let oldestUsed = Infinity
        for (const [id, entry] of urls) {
          if (entry.used < oldestUsed) {
            oldest = id
            oldestUsed = entry.used
          }
        }
        if (oldest === null) return
        revokeUrl(oldest)
      }
    }

    function forgetActive(runId: string): void {
      set((state) => {
        if (!(runId in state.active)) return {}
        const active = { ...state.active }
        delete active[runId]
        return { active }
      })
    }

    function dropRuns(at: Stamp, ids: readonly string[]): void {
      if (!isCurrent(at) || ids.length === 0) return
      const gone = new Set(ids)
      for (const id of ids) {
        live.get(id)?.controller.abort()
        live.delete(id)
        forgetActive(id)
      }
      for (const imageId of [...urls.keys()]) {
        if (gone.has(imageId.split(':')[0])) revokeUrl(imageId)
      }
      set((state) => ({ runs: state.runs.filter((run) => !gone.has(run.id)) }))
    }

    function commit(at: Stamp, meta: RunMeta): void {
      if (!isCurrent(at)) return
      set((state) => ({ runs: state.runs.map((run) => (run.id === meta.id ? meta : run)) }))
    }

    async function save(at: Stamp, meta: RunMeta): Promise<boolean> {
      if (!isCurrent(at)) return false
      const written = await persistence.update(meta)
      if (!written || !isCurrent(at)) return false
      commit(at, meta)
      return true
    }

    async function finish(
      at: Stamp,
      current: RunMeta,
      run: ProviderRun,
      provider: PlaygroundProvider,
      signal: AbortSignal,
      alive: () => boolean,
    ): Promise<void> {
      const base: RunMeta = { ...current, completedAt: now() }
      if (run.predictTime !== undefined) base.predictTime = run.predictTime
      if (run.status !== 'succeeded') {
        const error = run.error ?? (run.status === 'failed' ? 'The prediction failed.' : undefined)
        await save(at, { ...base, status: run.status, ...(error ? { error } : {}) })
        return
      }
      const blobs: Blob[] = []
      const outputs: OutputRef[] = []
      const errors: string[] = []
      for (const output of run.outputs ?? []) {
        try {
          const { blob, mime } = await provider.download(output, signal)
          outputs.push({ index: blobs.length, mime, size: blob.size })
          blobs.push(blob)
        } catch (error) {
          if (isAbort(error) || !alive()) throw error
          errors.push(describe(error))
        }
      }
      if (!alive()) return
      const final: RunMeta = {
        ...base,
        status: 'succeeded',
        outputs,
        bytes: current.bytes + blobs.reduce((total, blob) => total + blob.size, 0),
      }
      if (run.outputJson !== undefined) final.outputJson = run.outputJson
      if (errors.length === 1) final.error = errors[0]
      else if (errors.length > 1) final.error = `${errors.length} outputs could not be downloaded. ${errors[0]}`
      const removed = await persistence.addOutputs(final, blobs, get().runs)
      if (removed === null || !isCurrent(at)) return
      commit(at, final)
      dropRuns(at, removed)
    }

    async function follow(
      at: Stamp,
      meta: RunMeta,
      provider: PlaygroundProvider,
      controller: AbortController,
      begin?: { model: PlaygroundModel; input: Record<string, unknown> } | 'refetch',
    ): Promise<void> {
      const signal = controller.signal
      const alive = () => isCurrent(at) && !signal.aborted
      let current = meta
      const abandon = (providerRunId: string) => {
        void provider.cancel(providerRunId).catch(() => undefined)
      }
      const pollOnce = async (providerRunId: string): Promise<ProviderRun | null> => {
        for (let failures = 0; ; failures += 1) {
          try {
            return await provider.poll(providerRunId, signal)
          } catch (error) {
            if (!isTransient(error) || now() - meta.createdAt >= provider.retentionMs) throw error
            await sleep(Math.min(pollMs * 2 ** (failures + 1), MAX_POLL_BACKOFF_MS), signal)
            if (!alive()) return null
          }
        }
      }
      try {
        let run: ProviderRun
        if (begin === 'refetch') {
          const fresh = await pollOnce(current.providerRunId ?? '')
          if (!fresh || !alive()) return
          run = fresh
        } else if (begin) {
          run = await provider.start(begin.model, begin.input, signal)
          if (!alive()) {
            abandon(run.providerRunId)
            return
          }
          current = {
            ...current,
            providerRunId: run.providerRunId,
            status: isTerminal(run.status) ? 'processing' : run.status,
          }
          const accepted = run.providerRunId
          const saved = await save(at, current).catch((error: unknown) => {
            abandon(accepted)
            throw error
          })
          if (!saved) {
            abandon(accepted)
            return
          }
          if (get().active[meta.id]?.cancelRequested) await provider.cancel(run.providerRunId)
        } else {
          run = { providerRunId: current.providerRunId ?? '', status: current.status }
        }
        while (!isTerminal(run.status)) {
          await sleep(pollMs, signal)
          if (!alive()) return
          const next = await pollOnce(run.providerRunId)
          if (!next || !alive()) return
          run = next
          if (!isTerminal(run.status) && run.status !== current.status) {
            current = { ...current, status: run.status }
            if (!(await save(at, current))) return
          }
        }
        await finish(at, current, run, provider, signal, alive)
      } catch (error) {
        if (isAbort(error) || error instanceof VaultLockedError || !alive()) return
        const latest = get().runs.find((entry) => entry.id === meta.id) ?? current
        const status = begin === 'refetch' ? latest.status : 'failed'
        try {
          await save(at, { ...latest, status, error: describe(error), completedAt: now() })
        } catch {
          return
        }
      } finally {
        if (live.get(meta.id)?.controller === controller) {
          live.delete(meta.id)
          if (isCurrent(at)) forgetActive(meta.id)
        }
      }
    }

    function track(at: Stamp, meta: RunMeta, provider: PlaygroundProvider, begin?: Parameters<typeof follow>[4]): void {
      const controller = new AbortController()
      live.set(meta.id, { controller, provider })
      set((state) => ({ active: { ...state.active, [meta.id]: { cancelRequested: false } } }))
      void follow(at, meta, provider, controller, begin)
    }

    return {
      runs: [],
      active: {},
      models: {},
      hydrated: false,
      skipped: 0,
      error: null,

      hydrate(resolve) {
        if (get().hydrated) return Promise.resolve()
        if (hydrating) return hydrating
        const at = stamp()
        const task = (async () => {
          try {
            const { runs, skipped } = await persistence.list()
            if (!isCurrent(at)) return
            set((state) => {
              const known = new Set(state.runs.map((run) => run.id))
              return {
                runs: [...state.runs, ...runs.filter((run) => !known.has(run.id))].sort(newestFirst),
                skipped,
                hydrated: true,
                error: null,
              }
            })
            for (const meta of runs) {
              if (isTerminal(meta.status) || live.has(meta.id) || !isCurrent(at)) continue
              const provider = meta.providerRunId ? resolve(meta.providerId) : null
              try {
                if (!meta.providerRunId) {
                  const error = 'The run stopped before the provider accepted it.'
                  await save(at, { ...meta, status: 'interrupted', error, completedAt: now() })
                } else if (!provider) {
                  const error = 'The provider token was removed before this run finished.'
                  await save(at, { ...meta, status: 'interrupted', error, completedAt: now() })
                } else if (now() - meta.createdAt >= provider.retentionMs) {
                  await save(at, { ...meta, status: 'expired', completedAt: now() })
                } else {
                  track(at, meta, provider)
                }
              } catch (error) {
                if (error instanceof VaultLockedError) return
              }
            }
          } catch (error) {
            if (isCurrent(at)) set({ error: describe(error) })
          }
        })()
        const pending: Promise<void> = task.finally(() => {
          if (hydrating === pending) hydrating = null
        })
        hydrating = pending
        return pending
      },

      async resolveModel(provider, slug, signal) {
        const key = `${provider.id}:${slug.trim()}`
        const cached = get().models[key]
        if (cached) return cached
        const at = stamp()
        const model = await provider.getModel(slug, signal)
        if (isCurrent(at)) set((state) => ({ models: { ...state.models, [key]: model } }))
        return model
      },

      async start({ provider, model, input, fields, inputImages }) {
        const at = stamp()
        const images: ImageRef[] = inputImages.map((image, index) => ({
          field: image.field,
          index,
          name: image.name,
          mime: image.blob.type || 'application/octet-stream',
          size: image.blob.size,
        }))
        const { input: stored, secretFields } = storableInput(fields, input)
        const meta: RunMeta = {
          id: crypto.randomUUID(),
          providerId: provider.id,
          model: model.slug,
          modelLabel: model.label,
          input: withImageRefs(stored, fields, images),
          secretFields,
          inputImages: images,
          outputs: [],
          status: 'starting',
          bytes: images.reduce((total, image) => total + image.size, 0),
          createdAt: now(),
        }
        if (model.ref !== undefined) meta.ref = model.ref
        const removed = await persistence.create(
          meta,
          inputImages.map((image) => image.blob),
          get().runs,
        )
        if (!isCurrent(at)) throw new VaultLockedError()
        dropRuns(at, removed)
        set((state) => ({ runs: [meta, ...state.runs] }))
        track(at, meta, provider, { model, input })
        return meta.id
      },

      async cancel(runId) {
        const entry = live.get(runId)
        if (!entry) return
        set((state) => ({ active: { ...state.active, [runId]: { cancelRequested: true } } }))
        const providerRunId = get().runs.find((run) => run.id === runId)?.providerRunId
        if (!providerRunId) return
        try {
          await entry.provider.cancel(providerRunId)
        } catch (error) {
          if (live.get(runId) === entry) {
            set((state) => ({ active: { ...state.active, [runId]: { cancelRequested: false } } }))
          }
          throw error
        }
      },

      async remove(runId) {
        const at = stamp()
        const entry = live.get(runId)
        const meta = get().runs.find((run) => run.id === runId)
        if (entry) {
          entry.controller.abort()
          live.delete(runId)
          if (meta?.providerRunId && !isTerminal(meta.status)) {
            void entry.provider.cancel(meta.providerRunId).catch(() => undefined)
          }
        }
        await persistence.remove([runId])
        dropRuns(at, [runId])
      },

      async retryDownload(runId, provider) {
        const meta = get().runs.find((run) => run.id === runId)
        if (!meta || live.has(runId)) return
        if (meta.status !== 'succeeded' || meta.outputs.length > 0 || !meta.providerRunId) {
          throw new PlaygroundError('invalid_input', 'This run has no failed download to retry.')
        }
        if (now() - meta.createdAt >= provider.retentionMs) {
          throw new PlaygroundError('not_found', 'The provider has removed this output, so it can no longer be downloaded.')
        }
        const next: RunMeta = { ...meta }
        delete next.error
        track(stamp(), next, provider, 'refetch')
      },

      async imageUrl(id, mime) {
        const cached = urls.get(id)
        if (cached) {
          cached.refs += 1
          cached.used = ++tick
          return cached.url
        }
        let pending = pendingUrls.get(id)
        if (!pending) {
          const at = stamp()
          const task = (async () => {
            const bytes = await persistence.loadImage(id)
            if (!isCurrent(at)) throw new VaultLockedError()
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
            urls.set(id, { url, refs: 0, used: ++tick })
            return url
          })()
          pending = task.finally(() => pendingUrls.delete(id))
          pendingUrls.set(id, pending)
        }
        const url = await pending
        const entry = urls.get(id)
        if (entry) {
          entry.refs += 1
          entry.used = ++tick
        }
        trimUrls()
        return url
      },

      releaseImageUrl(id) {
        const entry = urls.get(id)
        if (!entry) return
        entry.refs -= 1
        if (entry.refs <= 0) revokeUrl(id)
      },

      async loadImageBlob(id, mime) {
        const bytes = await persistence.loadImage(id)
        return new Blob([bytes as BlobPart], { type: mime })
      },

      clear() {
        session += 1
        hydrating = null
        for (const entry of live.values()) entry.controller.abort()
        live.clear()
        for (const id of [...urls.keys()]) revokeUrl(id)
        pendingUrls.clear()
        set({ runs: [], active: {}, models: {}, hydrated: false, skipped: 0, error: null })
      },
    }
  })
}

export const usePlaygroundStore = createPlaygroundStore(playgroundPersistence)
