import { useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { useCallback } from 'react'
import { extractText, toThreadMessageLike } from './convert'
import type { IncomingContent } from './convert'

/**
 * A runtime for one delegated run's transcript, so the Agents panel renders the
 * same assistant-ui message components the main thread uses.
 *
 * The run is deliberately presented as an idle thread even while it streams:
 * the main composer queues a send while `isRunning`, which would swallow a
 * steering turn, whereas here a send must reach the run immediately. The run's
 * own status is shown in the panel header, not through the runtime.
 */
export function useSubAgentRuntime(
  messages: readonly UIMessage[],
  onSend: (text: string) => void,
) {
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractText(message.content as unknown as IncomingContent)
      if (text.trim().length > 0) onSend(text)
    },
    [onSend],
  )

  return useExternalStoreRuntime<UIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning: false,
    isLoading: false,
    onNew,
  })
}
