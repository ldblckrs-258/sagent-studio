import { useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { useCallback } from 'react'
import { useSession } from '../session/session-context'
import { useVaultStore } from '../vault/store'
import { extractText, toThreadMessageLike, toUiParts } from './convert'
import type { IncomingContent } from './convert'
import { redactSecrets } from './engine'
import { deleteMessage } from './reducer'
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
        await session.engineFor(id).sendTurn(id, text)
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
    try {
      await session.engineFor(id).cancel(id)
    } catch (error) {
      useChatStore.getState().setError(describe(error))
    }
  }, [session])

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
    onNew,
    onEdit,
    onReload,
    onCancel,
    onRespondToToolApproval,
    onDelete,
  })
}
