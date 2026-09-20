import { useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AppSession } from '../session/session'
import { useSession } from '../session/session-context'
import { useVaultStore } from '../vault/store'
import { extractText, toThreadMessageLike, toUiParts } from './convert'
import type { IncomingContent } from './convert'
import { redactSecrets } from './engine'
import { ChatThreadNotFoundError } from './errors'
import { createChatQueue } from './queue'
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
): Promise<void> {
  if (!looksLikeSlashCommand(text)) {
    await session.engineFor(threadId).sendTurn(threadId, text)
    return
  }
  const thread = useChatStore.getState().threads[threadId]
  if (!thread) throw new ChatThreadNotFoundError(threadId)
  await runSlashCommand(defaultSlashEntries(session.skillRegistry), {
    session,
    threadId,
    thread,
  }, text)
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
        dispatch: async (text) => {
          const id = await ensureActiveThread(session)
          if (!id) {
            useChatStore
              .getState()
              .setError('Add a provider in Config before sending a message.')
            return
          }
          await dispatchComposerText(session, id, text)
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
