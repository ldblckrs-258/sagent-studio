import { db } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { ChatConfigError, ChatError } from './errors'
import { validateThreadConfig } from './types'
import type { ChatThread } from './types'

export const THREAD_ENVELOPE_VERSION = 1

export interface ThreadSummary {
  id: string
  title: string
  workspaceName?: string
  updatedAt: number
}

export interface ThreadSummaryResult {
  summaries: ThreadSummary[]
  /** Rows that failed to decrypt or parse, so the UI can flag a partial list. */
  failures: number
  locked: boolean
}

function validateThread(value: unknown): ChatThread {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatConfigError('A thread must be a plain object.')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new ChatConfigError('A thread needs a non-empty id.')
  }
  if (typeof candidate.title !== 'string') {
    throw new ChatConfigError('A thread title must be a string.')
  }
  if (!Array.isArray(candidate.messages)) {
    throw new ChatConfigError('A thread messages field must be an array.')
  }
  if (
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    throw new ChatConfigError('Thread timestamps must be finite numbers.')
  }
  const thread: ChatThread = {
    id: candidate.id,
    title: candidate.title,
    messages: candidate.messages as ChatThread['messages'],
    config: validateThreadConfig(candidate.config),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  }
  // Additive and tolerant: a missing field is indistinguishable from an old
  // record, which is the intended read. The envelope version stays 1.
  if (typeof candidate.workspaceName === 'string') thread.workspaceName = candidate.workspaceName
  return thread
}

function parseEnvelope(raw: string): ChatThread {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ChatError('The decrypted thread was not valid JSON.', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ChatError('The thread envelope was not an object.')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ChatError('The thread envelope version is invalid.')
  }
  if (version > THREAD_ENVELOPE_VERSION) {
    throw new ChatError(
      `Thread envelope version ${version} is newer than this app supports (${THREAD_ENVELOPE_VERSION}).`,
    )
  }
  return validateThread((parsed as { thread?: unknown }).thread)
}

export async function saveThread(thread: ChatThread): Promise<void> {
  const validated = validateThread(thread)
  await vaultWriteQueue.enqueue(async () => {
    const envelope = JSON.stringify({ version: THREAD_ENVELOPE_VERSION, thread: validated })
    const blob = await encryptRecord(envelope, `thread:${validated.id}`)
    await db.threads.put({ id: validated.id, blob, updatedAt: validated.updatedAt })
  })
}

export async function createThread(thread: ChatThread): Promise<ChatThread> {
  const validated = validateThread(thread)
  await saveThread(validated)
  return validated
}

export async function loadThread(id: string): Promise<ChatThread | null> {
  const row = await db.threads.get(id)
  if (!row) return null
  return parseEnvelope(await decryptRecord(row.blob, `thread:${id}`))
}

/**
 * Loads every row and decrypts each one independently. One corrupt envelope
 * cannot hide the rest of the list; a locked vault returns no rows rather than
 * rejecting. Titles and labels are never stored in plaintext.
 */
export async function listThreadSummaries(): Promise<ThreadSummaryResult> {
  const rows = await db.threads.orderBy('updatedAt').reverse().toArray()
  const summaries: ThreadSummary[] = []
  let failures = 0
  let locked = false

  for (const row of rows) {
    try {
      const thread = parseEnvelope(await decryptRecord(row.blob, `thread:${row.id}`))
      summaries.push({
        id: thread.id,
        title: thread.title,
        updatedAt: row.updatedAt,
        ...(thread.workspaceName !== undefined ? { workspaceName: thread.workspaceName } : {}),
      })
    } catch (error) {
      if (error instanceof VaultLockedError) {
        locked = true
        break
      }
      failures += 1
    }
  }

  return { summaries, failures, locked }
}

export async function listThreads(): Promise<ThreadSummary[]> {
  return (await listThreadSummaries()).summaries
}

async function patchThread(
  id: string,
  patch: Partial<Pick<ChatThread, 'title' | 'workspaceName'>>,
): Promise<void> {
  // One queued read-modify-write: re-reading inside the task removes the window
  // where a delete could be overwritten, and the tombstone guard prevents a
  // pending rename from resurrecting a deleted row.
  await vaultWriteQueue.enqueue(async () => {
    const row = await db.threads.get(id)
    if (!row) return
    const current = parseEnvelope(await decryptRecord(row.blob, `thread:${id}`))
    const next: ChatThread = { ...current, ...patch, updatedAt: Date.now() }
    if (patch.workspaceName === undefined && 'workspaceName' in patch) delete next.workspaceName
    const validated = validateThread(next)
    const envelope = JSON.stringify({ version: THREAD_ENVELOPE_VERSION, thread: validated })
    const blob = await encryptRecord(envelope, `thread:${id}`)
    await db.threads.put({ id, blob, updatedAt: validated.updatedAt })
  })
}

export async function renameThread(id: string, title: string): Promise<void> {
  await patchThread(id, { title })
}

export async function setThreadWorkspaceLabel(
  id: string,
  workspaceName: string | undefined,
): Promise<void> {
  await patchThread(id, { workspaceName })
}

export async function deleteThread(id: string): Promise<void> {
  // Deletion needs no key, but it stays on the shared queue so a pending save for
  // the same id cannot land after the delete and resurrect the thread.
  await vaultWriteQueue.enqueue(async () => {
    await db.threads.delete(id)
  })
}
