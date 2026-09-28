import { useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { modelSupportsVision } from '../ai/model-caps'
import type { AppSession } from '../session/session'
import { useSession } from '../session/session-context'
import { useWorkspaceStore } from '../session/workspace-state'
import { useVaultStore } from '../vault/store'
import {
  autoAttachmentForThread,
  composerThreadKey,
  subscribeAttachmentThreadChanges,
  subscribeAutoTargetOwner,
  useAttachmentStore,
} from './attachment-store'
import type { ResolvedAttachments } from './attachments'
import { resolveAttachments } from './attachments'
import { extractText, toThreadMessageLike, toUiParts } from './convert'
import type { IncomingContent } from './convert'
import { redactSecrets } from './engine'
import { ChatThreadNotFoundError } from './errors'
import { createChatQueue } from './queue'
import type { AttachmentSnapshot } from './queue'
import type { McpResourcePort } from '../tools/types'
import { deleteMessage } from './reducer'
import {
  defaultSlashEntries,
  looksLikeSlashCommand,
  runSlashCommand,
} from './slash'
import { useChatStore } from './store'
import { ensureActiveThread } from './active-thread'

const EMPTY_MESSAGES: readonly UIMessage[] = []
const EMPTY_PROVIDERS: readonly unknown[] = []

function describe(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message)
  return redactSecrets(String(error))
}

type ReloadConfig = { sourceId?: string | null }

/**
 * The single send path. Slash text runs through the registry and plain text
 * starts a turn, so a command typed directly and one that arrives later out of
 * the queue take exactly the same route.
 */
export async function dispatchComposerText(
  session: AppSession,
  threadId: string,
  text: string,
  attachments?: ResolvedAttachments,
): Promise<void> {
  if (!looksLikeSlashCommand(text)) {
    await session
      .engineFor(threadId)
      .sendTurn(threadId, text, attachments ? { attachments } : {})
    return
  }
  const thread = useChatStore.getState().threads[threadId]
  if (!thread) throw new ChatThreadNotFoundError(threadId)
  await runSlashCommand(defaultSlashEntries(session.skillRegistry, session.mcp), {
    session,
    threadId,
    thread,
  }, text)
}

/**
 * Manual chips plus the auto chip, read at the moment the user presses send.
 *
 * A slash command routes through the registry rather than `sendTurn`, so it
 * cannot carry attachments; capturing for one would clear the chips and drop
 * them silently. They stay in the composer for the next real turn instead.
 */
function captureAttachments(text: string): AttachmentSnapshot | undefined {
  if (looksLikeSlashCommand(text)) return undefined
  const threadId = composerThreadKey()
  const manual = useAttachmentStore.getState().take(threadId)
  const auto = autoAttachmentForThread(threadId)
  const attachments = auto === null ? manual : [...manual, auto]
  if (attachments.length === 0) return undefined
  // The folder is captured too: `boundThreadId` moves synchronously at the
  // start of `bindThread` while `fs` is still the previous thread's handle,
  // so an id comparison alone would let a send inside that window resolve
  // against the wrong folder.
  return { threadId, attachments, fs: useWorkspaceStore.getState().fs }
}

/**
 * Resolves a snapshot against the folder bound *now*, not the one bound when
 * the message was typed. A queued message therefore sends the file's current
 * content, which is the same rule an immediate send follows; a message whose
 * thread changed under it resolves nothing at all.
 */
/** A resolution that could not run. The turn still sends its text. */
export class AttachmentsDroppedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentsDroppedError'
  }
}

export async function resolveSnapshot(
  snapshot: AttachmentSnapshot,
  threadId: string,
  mcp?: McpResourcePort,
): Promise<ResolvedAttachments | undefined> {
  const workspace = useWorkspaceStore.getState()
  const fs = workspace.fs
  if (snapshot.threadId !== '' && snapshot.threadId !== threadId) {
    throw new AttachmentsDroppedError(
      'The conversation changed before this message was sent, so it was sent without its attachments.',
    )
  }
  const onlyMcp = snapshot.attachments.every((attachment) => attachment.kind === 'mcp-resource')
  if (fs === null && !onlyMcp) {
    throw new AttachmentsDroppedError(
      'No workspace folder is open, so this message was sent without its attachments.',
    )
  }
  if (!onlyMcp && snapshot.fs !== null && snapshot.fs !== fs) {
    throw new AttachmentsDroppedError(
      'The workspace folder changed before this message was sent, so it was sent without its attachments.',
    )
  }
  const settings = useVaultStore.getState().settings
  const config = useChatStore.getState().threads[threadId]?.config
  const resolved = await resolveAttachments(fs, snapshot.attachments, {
    imageSupport: modelSupportsVision(settings, config?.providerId, config?.modelId),
    ...(mcp ? { mcp } : {}),
  })
  if (resolved.errors.length > 0) {
    useChatStore.getState().setError(resolved.errors.join(' '))
  }
  return resolved.items.length === 0 ? undefined : resolved
}

/**
 * Bridges the engine-owned `useChatStore` thread into an assistant-ui runtime.
 * `isRunning` is explicit from the global active-run count, `setMessages` writes
 * in memory for the runtime's own rewrites, and `onDelete` is the one path that
 * persists, because supplying `setMessages` turns on the delete capability.
 */
export function useChatRuntime() {
  const session = useSession()
  const messages = useChatStore(
    (s) => s.threads[s.activeThreadId ?? '']?.messages ?? EMPTY_MESSAGES,
  )
  const isRunning = useChatStore((s) =>
    s.activeThreadId ? (s.runningThreads[s.activeThreadId] ?? 0) > 0 : false,
  )
  const settings = useVaultStore((s) => s.settings)
  const providers = settings?.providers ?? EMPTY_PROVIDERS

  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const [, bumpQueueVersion] = useReducer((version: number) => version + 1, 0)

  const queue = useMemo(
    () =>
      createChatQueue({
        capture: captureAttachments,
        dispatch: async (text, snapshot) => {
          const id = await ensureActiveThread(session)
          if (!id) {
            useChatStore
              .getState()
              .setError('Add a provider in Config before sending a message.')
            return
          }
          // The user's text must survive every attachment failure: the
          // composer has already cleared its draft by the time this runs, so a
          // rejection here would destroy the turn rather than degrade it.
          let attachments: ResolvedAttachments | undefined
          if (snapshot !== undefined) {
            try {
              attachments = await resolveSnapshot(snapshot, id, session.mcpResources)
            } catch (error) {
              useChatStore.getState().setError(describe(error))
            }
          }
          await dispatchComposerText(session, id, text, attachments)
        },
        onError: (error) => useChatStore.getState().setError(describe(error)),
        externalRunCount: () => {
          const state = useChatStore.getState()
          return state.activeThreadId
            ? (state.runningThreads[state.activeThreadId] ?? 0)
            : 0
        },
      }),
    [session],
  )

  // A run started outside the queue (a rerun, an edit, an approval resume)
  // shows up only in the store, so every store change re-reads it; the queue
  // settles its own dispatches itself.
  useEffect(() => {
    queue.sync()
    return useChatStore.subscribe(queue.sync)
  }, [queue])

  // Chips are keyed by thread because the workspace is; a conversation switch
  // drops the ones the user left behind, mirroring the queue's own reset.
  useEffect(() => subscribeAttachmentThreadChanges(), [])

  // Records which conversation opened the file the File panel shows, so the
  // auto chip cannot follow the user into another thread's folder.
  useEffect(() => subscribeAutoTargetOwner(), [])

  // The runtime does not subscribe to the queue, so a lane change has to be
  // turned into a render here or a removed item lingers on screen.
  useEffect(() => queue.subscribe(bumpQueueVersion), [queue])

  // Only a real thread-to-thread change drops pending items. The first send of
  // a session moves `activeThreadId` from null to its new id, and treating that
  // as a switch would silently discard a message typed during the round trip.
  const previousThreadId = useRef<string | null>(activeThreadId)
  useEffect(() => {
    const previous = previousThreadId.current
    previousThreadId.current = activeThreadId
    if (previous !== null && previous !== activeThreadId) queue.reset()
  }, [queue, activeThreadId])

  const setMessages = useCallback((next: readonly UIMessage[]) => {
    const state = useChatStore.getState()
    const id = state.activeThreadId
    if (!id) return
    const thread = state.threads[id]
    if (!thread) return
    state.setThread({ ...thread, messages: [...next] })
  }, [])

  // Unreachable in this app: `queue` is always supplied, and the external-store
  // runtime returns into `enqueue`/`steer` before it ever reaches `onNew`. It
  // stays as the runtime's required fallback — do not wire send logic here.
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractText(message.content as unknown as IncomingContent)
      try {
        const id = await ensureActiveThread(session)
        if (!id) {
          useChatStore.getState().setError('Add a provider in Config before sending a message.')
          return
        }
        await dispatchComposerText(session, id, text)
      } catch (error) {
        useChatStore.getState().setError(describe(error))
      }
    },
    [session],
  )

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      const id = useChatStore.getState().activeThreadId
      if (!id || !message.sourceId) return
      try {
        await session
          .engineFor(id)
          .editMessage(id, message.sourceId, toUiParts(message.content as unknown as IncomingContent))
      } catch (error) {
        useChatStore.getState().setError(describe(error))
      }
    },
    [session],
  )

  const onReload = useCallback(
    async (_parentId: string | null, config: ReloadConfig) => {
      const id = useChatStore.getState().activeThreadId
      if (!id || !config.sourceId) return
      try {
        await session.engineFor(id).rerun(id, config.sourceId)
      } catch (error) {
        useChatStore.getState().setError(describe(error))
      }
    },
    [session],
  )

  const onRespondToToolApproval = useCallback(
    async (response: {
      approvalId: string
      approved: boolean
      optionId?: string
      reason?: string
    }) => {
      const id = useChatStore.getState().activeThreadId
      if (!id) return
      try {
        await session.engineFor(id).respondToApproval(id, response)
      } catch (error) {
        useChatStore.getState().setError(describe(error))
      }
    },
    [session],
  )

  const onCancel = useCallback(async () => {
    const id = useChatStore.getState().activeThreadId
    if (!id) return
    // Before the abort, so the settle it produces holds the pending items
    // instead of dispatching the next one at the moment the user stopped.
    queue.notifyCancelled()
    try {
      await session.engineFor(id).cancel(id)
    } catch (error) {
      useChatStore.getState().setError(describe(error))
    }
  }, [queue, session])

  const onDelete = useCallback(
    async (messageId: string) => {
      const state = useChatStore.getState()
      const id = state.activeThreadId
      if (!id) return
      const thread = state.threads[id]
      if (!thread) return
      const next = deleteMessage(thread.messages, messageId)
      if (next === thread.messages) return
      const updated = { ...thread, messages: next, updatedAt: Date.now() }
      state.setThread(updated)
      try {
        await session.threadStore.saveThread(updated)
      } catch (error) {
        state.setError(describe(error))
      }
    },
    [session],
  )

  return useExternalStoreRuntime<UIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning,
    isLoading: false,
    // Disabled only when the vault itself is unavailable; a missing conversation
    // is created on the first send, so a configured provider is enough to chat.
    isDisabled: settings === null,
    isSendDisabled: providers.length === 0,
    setMessages,
    queue: queue.adapter,
    onNew,
    onEdit,
    onReload,
    onCancel,
    onRespondToToolApproval,
    onDelete,
  })
}
