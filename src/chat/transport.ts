import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { buildRunStream } from './engine'
import type { PipelineDeps } from './engine'
import type { ThreadConfig } from './types'

export interface ChatTransportDeps extends PipelineDeps {
  getConfig(): ThreadConfig
}

export function createChatTransport(deps: ChatTransportDeps): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }): Promise<ReadableStream<UIMessageChunk>> {
      const signal = abortSignal ?? new AbortController().signal
      const built = await buildRunStream(
        deps,
        deps.getConfig(),
        messages,
        signal,
        () => crypto.randomUUID(),
      )
      return built.stream
    },

    async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
      return null
    },
  }
}
