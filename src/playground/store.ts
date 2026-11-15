import { db } from '../vault/db'
import type { PlaygroundImageRecord } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import { decryptRecord, decryptRecordBytes, encryptRecord, encryptRecordBytes } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { PlaygroundError } from './errors'
import type { PlaygroundProviderId, RunStatus } from './types'

export const PLAYGROUND_RUN_ENVELOPE_VERSION = 1
export const MAX_PLAYGROUND_RUNS = 200
export const MAX_PLAYGROUND_BYTES = 1024 * 1024 * 1024

export type ImageRole = 'input' | 'output'

export interface ImageRef {
  field: string
  index: number
  name: string
  mime: string
  size: number
}

export interface OutputRef {
  index: number
  mime: string
  size: number
}

export interface RunMeta {
  id: string
  providerId: PlaygroundProviderId
  model: string
  modelLabel: string
  ref?: unknown
  input: Record<string, unknown>
  secretFields: string[]
  inputImages: ImageRef[]
  outputs: OutputRef[]
  outputJson?: unknown
  status: RunStatus
  error?: string
  providerRunId?: string
  predictTime?: number
  bytes: number
  createdAt: number
  completedAt?: number
}

const STATUSES = new Set<RunStatus>([
  'starting',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
  'expired',
])

const STORAGE_FULL_MESSAGE = 'Browser storage is full. Delete some playground runs and try again.'

export class PlaygroundParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaygroundParseError'
  }
}

export function imageId(runId: string, role: ImageRole, index: number): string {
  return `${runId}:${role}:${index}`
}

function runSeed(id: string): string {
  return `playground-run:${id}`
}

function imageSeed(id: string): string {
  return `playground-image:${id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunMeta(value: unknown): value is RunMeta {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.model === 'string' &&
    typeof value.modelLabel === 'string' &&
    isRecord(value.input) &&
    Array.isArray(value.secretFields) &&
    Array.isArray(value.inputImages) &&
    Array.isArray(value.outputs) &&
    typeof value.status === 'string' &&
    STATUSES.has(value.status as RunStatus) &&
    typeof value.bytes === 'number' &&
    typeof value.createdAt === 'number'
  )
}

export function parseEnvelope(raw: string, id: string): RunMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PlaygroundParseError('The decrypted playground run was not valid JSON.')
  }
  if (!isRecord(parsed)) throw new PlaygroundParseError('The playground run envelope was not an object.')
  const version = parsed.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PlaygroundParseError('The playground run envelope version is invalid.')
  }
  if (version > PLAYGROUND_RUN_ENVELOPE_VERSION) {
    throw new PlaygroundParseError(`Playground run envelope version ${version} is newer than this app supports.`)
  }
  if (!isRunMeta(parsed.run) || parsed.run.id !== id) {
    throw new PlaygroundParseError('The stored playground run is malformed.')
  }
  return parsed.run
}

function isQuotaError(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof Error)) return false
  const record = error as { name?: unknown; inner?: { name?: unknown } }
  return record.name === 'QuotaExceededError' || record.inner?.name === 'QuotaExceededError'
}

async function mapQuota<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (isQuotaError(error)) throw new PlaygroundError('storage_full', STORAGE_FULL_MESSAGE, { cause: error })
    throw error
  }
}

export function pruneFor(next: RunMeta, existing: readonly RunMeta[]): string[] {
  const others = existing.filter((run) => run.id !== next.id).sort((a, b) => a.createdAt - b.createdAt)
  let count = others.length + 1
  let bytes = others.reduce((total, run) => total + run.bytes, next.bytes)
  const removed: string[] = []
  for (const run of others) {
    if (count <= MAX_PLAYGROUND_RUNS && bytes <= MAX_PLAYGROUND_BYTES) break
    removed.push(run.id)
    count -= 1
    bytes -= run.bytes
  }
  return removed
}

async function sealRun(meta: RunMeta) {
  const envelope = JSON.stringify({ version: PLAYGROUND_RUN_ENVELOPE_VERSION, run: meta })
  return { id: meta.id, blob: await encryptRecord(envelope, runSeed(meta.id)), createdAt: meta.createdAt }
}

async function sealImages(runId: string, role: ImageRole, blobs: readonly Blob[]): Promise<PlaygroundImageRecord[]> {
  const records: PlaygroundImageRecord[] = []
  for (const [index, blob] of blobs.entries()) {
    const id = imageId(runId, role, index)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    records.push({ id, runId, blob: await encryptRecordBytes(bytes, imageSeed(id)) })
  }
  return records
}

async function deleteRuns(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await db.playgroundRuns.bulkDelete([...ids])
  await db.playgroundImages.where('runId').anyOf([...ids]).delete()
}

export async function createRun(
  meta: RunMeta,
  inputImages: readonly Blob[],
  existing: readonly RunMeta[],
): Promise<string[]> {
  let removed: string[] = []
  await vaultWriteQueue.enqueue(async () => {
    const row = await sealRun(meta)
    const images = await sealImages(meta.id, 'input', inputImages)
    removed = pruneFor(meta, existing)
    await mapQuota(() =>
      db.transaction('rw', db.playgroundRuns, db.playgroundImages, async () => {
        await deleteRuns(removed)
        await db.playgroundRuns.put(row)
        if (images.length > 0) await db.playgroundImages.bulkPut(images)
      }),
    )
  })
  return removed
}

export async function updateRun(meta: RunMeta): Promise<boolean> {
  let written = false
  await vaultWriteQueue.enqueue(async () => {
    const row = await sealRun(meta)
    await mapQuota(() =>
      db.transaction('rw', db.playgroundRuns, async () => {
        if (!(await db.playgroundRuns.get(meta.id))) return
        await db.playgroundRuns.put(row)
        written = true
      }),
    )
  })
  return written
}

export async function addOutputs(
  meta: RunMeta,
  outputs: readonly Blob[],
  existing: readonly RunMeta[],
): Promise<string[] | null> {
  let removed: string[] | null = null
  await vaultWriteQueue.enqueue(async () => {
    const row = await sealRun(meta)
    const images = await sealImages(meta.id, 'output', outputs)
    const prune = pruneFor(meta, existing)
    await mapQuota(() =>
      db.transaction('rw', db.playgroundRuns, db.playgroundImages, async () => {
        if (!(await db.playgroundRuns.get(meta.id))) return
        await deleteRuns(prune)
        await db.playgroundRuns.put(row)
        if (images.length > 0) await db.playgroundImages.bulkPut(images)
        removed = prune
      }),
    )
  })
  return removed
}

export async function listRunMeta(): Promise<{ runs: RunMeta[]; skipped: number }> {
  const rows = await db.playgroundRuns.toArray()
  const runs: RunMeta[] = []
  let skipped = 0
  for (const row of rows) {
    try {
      runs.push(parseEnvelope(await decryptRecord(row.blob, runSeed(row.id)), row.id))
    } catch (error) {
      if (error instanceof VaultLockedError) throw error
      skipped += 1
    }
  }
  runs.sort((a, b) => b.createdAt - a.createdAt)
  return { runs, skipped }
}

export async function loadImage(id: string): Promise<Uint8Array> {
  const row = await db.playgroundImages.get(id)
  if (!row) throw new PlaygroundError('not_found', 'The stored image is missing.')
  return decryptRecordBytes(row.blob, imageSeed(id))
}

export async function removeRuns(ids: readonly string[]): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    await db.transaction('rw', db.playgroundRuns, db.playgroundImages, () => deleteRuns(ids))
  })
}

export interface PlaygroundPersistence {
  list(): Promise<{ runs: RunMeta[]; skipped: number }>
  create(meta: RunMeta, inputImages: readonly Blob[], existing: readonly RunMeta[]): Promise<string[]>
  update(meta: RunMeta): Promise<boolean>
  addOutputs(meta: RunMeta, outputs: readonly Blob[], existing: readonly RunMeta[]): Promise<string[] | null>
  loadImage(id: string): Promise<Uint8Array>
  remove(ids: readonly string[]): Promise<void>
}

export const playgroundPersistence: PlaygroundPersistence = {
  list: listRunMeta,
  create: createRun,
  update: updateRun,
  addOutputs,
  loadImage,
  remove: removeRuns,
}
