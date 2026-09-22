import type { Settings } from '../vault/settings'
import { clearWorkspaceHandle, threadHandleId } from '../workspace/handle'
import { workspaceJournalStore } from '../workspace/journal-store'
import { createThread, deleteThread, renameThread, setThreadWorkspaceLabel } from './persistence'
import type { ThreadSummary } from './persistence'
import type { ChatMode, ChatThread, SkillRef, ThreadConfig } from './types'

export const DEFAULT_CHAT_MODE: ChatMode = 'editing'

export const DEFAULT_TITLE = 'New chat'
export const MAX_TITLE_LENGTH = 80

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Trims and clamps a title; an empty title falls back to `New chat`. */
export function normalizeTitle(title: string): string {
  const trimmed = title.trim()
  return (trimmed.length > 0 ? trimmed : DEFAULT_TITLE).slice(0, MAX_TITLE_LENGTH)
}

export interface ProviderSelection {
  providerId: string
  modelId?: string
}

/**
 * The single default-provider rule: the first configured provider with its
 * `defaultModel`. Deterministic because array order is the only tie-break.
 */
export function defaultProviderFor(settings: Settings | null): ProviderSelection | null {
  const provider = settings?.providers[0]
  if (!provider) return null
  const modelId = provider.defaultModel || provider.models[0]?.id
  return modelId ? { providerId: provider.id, modelId } : { providerId: provider.id }
}

export interface CreateConversationInput {
  title?: string
  config: ThreadConfig
  workspaceName?: string
}

export async function createConversation(input: CreateConversationInput): Promise<ChatThread> {
  const now = Date.now()
  const config = input.config
  const thread: ChatThread = {
    id: newId(),
    title: normalizeTitle(input.title ?? DEFAULT_TITLE),
    messages: [],
    config,
    mode: DEFAULT_CHAT_MODE,
    createdAt: now,
    updatedAt: now,
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
  }
  return createThread(thread)
}

/** Merges a config patch and stamps `updatedAt`; the only way a thread config changes. */
export function patchThreadConfig(thread: ChatThread, patch: Partial<ThreadConfig>): ChatThread {
  return { ...thread, config: { ...thread.config, ...patch }, updatedAt: Date.now() }
}

/**
 * Seeds a new conversation with the globally enabled skills, so a fresh chat
 * starts with the same toolbelt the user already turned on instead of empty.
 * A conversation still owns its own list from that point on; later global
 * changes do not rewrite it.
 */
export function withEnabledSkills(
  config: ThreadConfig,
  enabled: readonly SkillRef[],
): ThreadConfig {
  return enabled.length > 0
    ? { ...config, enabledSkills: enabled.map((ref) => ({ ...ref })) }
    : config
}


/** Sets a thread-level field like `mode`; the only writer of `ChatThread.mode`. */
export function patchThreadMode(thread: ChatThread, mode: ChatMode): ChatThread {
  return { ...thread, mode, updatedAt: Date.now() }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await renameThread(id, normalizeTitle(title))
}

export async function deleteConversation(id: string): Promise<void> {
  await deleteThread(id)
  // The journal and the folder handle are scoped to the conversation, so they
  // go with it.
  await workspaceJournalStore.remove(id)
  await clearWorkspaceHandle(threadHandleId(id))
}

export async function labelConversation(id: string, workspaceName: string | undefined): Promise<void> {
  await setThreadWorkspaceLabel(id, workspaceName)
}

export interface ConversationGroup {
  workspaceName: string | null
  threads: ThreadSummary[]
}

const NO_WORKSPACE_KEY = '\u0000'

function byUpdatedDesc(a: ThreadSummary, b: ThreadSummary): number {
  return b.updatedAt - a.updatedAt
}

/**
 * Groups summaries by the snapshotted workspace label. Named groups sort
 * alphabetically; the `null` ("No workspace") group is always last. Each group
 * is ordered newest first.
 */
export function groupConversations(summaries: readonly ThreadSummary[]): ConversationGroup[] {
  const groups = new Map<string, ThreadSummary[]>()
  for (const summary of summaries) {
    const key = summary.workspaceName ?? NO_WORKSPACE_KEY
    const list = groups.get(key)
    if (list) list.push(summary)
    else groups.set(key, [summary])
  }

  const named: ConversationGroup[] = [...groups.entries()]
    .filter(([key]) => key !== NO_WORKSPACE_KEY)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workspaceName, threads]) => ({
      workspaceName,
      threads: [...threads].sort(byUpdatedDesc),
    }))

  const noWorkspace = groups.get(NO_WORKSPACE_KEY)
  if (noWorkspace) named.push({ workspaceName: null, threads: [...noWorkspace].sort(byUpdatedDesc) })

  return named
}
