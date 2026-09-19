import type { AppSession } from '../session/session'
import { useVaultStore } from '../vault/store'
import { useChatStore } from './store'
import { createConversation, defaultProviderFor } from './threads'
import { defaultThreadConfig } from './types'

/**
 * The active conversation id, creating and persisting one when none is selected
 * yet. This is the single entry point for "the user did something chatty before
 * starting a conversation": first send, or picking a model for the first time.
 * Returns `null` when no provider is configured, because a thread cannot run.
 */
export async function ensureActiveThread(session: AppSession): Promise<string | null> {
  const active = useChatStore.getState().activeThreadId
  if (active) return active
  const provider = defaultProviderFor(useVaultStore.getState().settings)
  if (!provider) return null
  const workspace = session.getWorkspace()
  const thread = await createConversation({
    config: defaultThreadConfig(provider.providerId, provider.modelId),
    workspaceName: workspace?.handle.name,
  })
  useChatStore.getState().setThread(thread)
  useChatStore.getState().setActiveThread(thread.id)
  return thread.id
}
