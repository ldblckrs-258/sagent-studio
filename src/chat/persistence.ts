import { db } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { MODEL_TIERS } from '../vault/settings'
import type { ModelTier } from '../vault/settings'
import { ChatConfigError, ChatError } from './errors'
import { validatePlanItems } from './plan'
import { rehydrateThread } from './sanitize'
import { isAgentRunStatus, isChatMode, validateThreadConfig } from './types'
import type { AgentRunSpec, AgentThreadMeta, ChatThread } from './types'

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
  // Tolerant: an absent or unrecognized mode reads as `editing` (absent field).
  if (isChatMode(candidate.mode)) thread.mode = candidate.mode
  const plan = validatePlanItems(candidate.plan)
  if (plan !== undefined) thread.plan = plan
  if (candidate.titleSource === 'auto' || candidate.titleSource === 'user') {
    thread.titleSource = candidate.titleSource
  }
  if (
    typeof candidate.titleUserCount === 'number' &&
    Number.isInteger(candidate.titleUserCount) &&
    candidate.titleUserCount >= 0
  ) {
    thread.titleUserCount = candidate.titleUserCount
  }
  const agent = validateAgentMeta(candidate.agent)
  if (agent) thread.agent = agent
  return thread
}

/** Reads the child-run metadata tolerantly; a malformed block is dropped. */
function validateAgentMeta(value: unknown): AgentThreadMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return undefined
  if (typeof candidate.parentThreadId !== 'string' || candidate.parentThreadId.length === 0) {
    return undefined
  }
  if (!isChatMode(candidate.mode)) return undefined
  if (!isAgentRunStatus(candidate.status)) return undefined
  if (!(MODEL_TIERS as readonly string[]).includes(candidate.tier as string)) return undefined
  const meta: AgentThreadMeta = {
    runId: candidate.runId,
    parentThreadId: candidate.parentThreadId,
    mode: candidate.mode,
    tier: candidate.tier as ModelTier,
    status: candidate.status,
  }
  if (typeof candidate.label === 'string') meta.label = candidate.label
  if (typeof candidate.profile === 'string' && candidate.profile.length > 0) meta.profile = candidate.profile
  if (candidate.stopReason === 'user_stop') meta.stopReason = candidate.stopReason
  const spec = validateAgentSpec(candidate.spec)
  if (spec) meta.spec = spec
  return meta
}

function readNameList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null
  return [...value]
}

function validateAgentSpec(value: unknown): AgentRunSpec | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!isChatMode(candidate.mode)) return undefined
  const toolNames = readNameList(candidate.toolNames)
  if (!toolNames) return undefined
  const skills = readNameList(candidate.skills)
  const excludeTools = readNameList(candidate.excludeTools)
  const allowTools = readNameList(candidate.allowTools)
  if (skills === null || excludeTools === null || allowTools === null) return undefined
  const schema = candidate.outputSchema
  const outputSchema =
    typeof schema === 'object' && schema !== null && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : undefined
  return {
    mode: candidate.mode,
    toolNames,
    ...(typeof candidate.profile === 'string' && candidate.profile.length > 0
      ? { profile: candidate.profile }
      : {}),
    ...(skills ? { skills } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(allowTools ? { allowTools } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  }
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
      // A child agent thread is not a conversation; it surfaces in the Agents
      // panel via `listAgentRuns`.
      if (thread.agent) continue
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

/**
 * Loads persisted child agent threads, newest first, optionally limited to one
 * parent conversation. A corrupt or locked row is skipped rather than hiding
 * the rest, matching `listThreadSummaries`.
 */
export async function listAgentRuns(parentThreadId?: string): Promise<ChatThread[]> {
  const rows = await db.threads.orderBy('updatedAt').reverse().toArray()
  const runs: ChatThread[] = []
  for (const row of rows) {
    try {
      const thread = parseEnvelope(await decryptRecord(row.blob, `thread:${row.id}`))
      if (!thread.agent) continue
      if (parentThreadId !== undefined && thread.agent.parentThreadId !== parentThreadId) continue
      // A reload cannot resume a detached run, so a persisted `running` child is
      // reconciled to `interrupted` here, where the panel reads it.
      runs.push(rehydrateThread(thread))
    } catch {
      // A locked vault or a corrupt row simply yields no run for that id.
    }
  }
  return runs
}

/** Deletes every child agent thread of a parent conversation. */
export async function deleteAgentRunsForParent(parentThreadId: string): Promise<void> {
  const runs = await listAgentRuns(parentThreadId)
  for (const run of runs) await deleteThread(run.id)
}

async function patchThread(
  id: string,
  patch: Partial<Pick<ChatThread, 'title' | 'titleSource' | 'titleUserCount' | 'workspaceName'>>,
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
  // A manual rename claims the title: the naming task must never overwrite it.
  await patchThread(id, { title, titleSource: 'user' })
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
