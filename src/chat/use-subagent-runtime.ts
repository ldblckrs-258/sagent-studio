import { useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage, ExternalThreadQueueAdapter } from '@assistant-ui/react'
import type { UIMessage } from 'ai'
import { useCallback, useMemo } from 'react'
import { extractText, toThreadMessageLike } from './convert'
import type { IncomingContent } from './convert'

export interface SubAgentRuntimeOptions {
  isRunning: boolean
  onSteer: (text: string) => void
  onStop: () => void
}

export function useSubAgentRuntime(
  messages: readonly UIMessage[],
  { isRunning, onSteer, onStop }: SubAgentRuntimeOptions,
) {
  const deliver = useCallback(
    (message: AppendMessage) => {
      const text = extractText(message.content as unknown as IncomingContent)
      if (text.trim().length > 0) onSteer(text)
    },
    [onSteer],
  )

  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: [],
      steerItems: [],
      enqueue: deliver,
      steer: deliver,
      move: () => {},
      edit: () => {},
      remove: () => {},
    }),
    [deliver],
  )

  const onNew = useCallback(async (message: AppendMessage) => deliver(message), [deliver])
  const onCancel = useCallback(async () => onStop(), [onStop])

  return useExternalStoreRuntime<UIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning,
    isLoading: false,
    queue,
    onNew,
    onCancel,
  })
}
