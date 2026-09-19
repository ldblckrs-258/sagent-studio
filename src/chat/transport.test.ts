import { describe, expect, it } from 'vitest'
import { readUIMessageStream } from 'ai'
import type { UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import { defaultSettings } from '../vault/settings'
import { createChatTransport } from './transport'
import { defaultThreadConfig } from './types'

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | {
      type: 'finish'
      usage: {
        inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
        outputTokens: { total: number; text: number; reasoning: number }
      }
      finishReason: { unified: 'stop'; raw: string | undefined }
    }

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function textStep(delta: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      finishReason: { unified: 'stop', raw: undefined },
    },
  ]
}

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

describe('createChatTransport', () => {
  it('runs one pipeline pass and returns a chunk stream that folds to the assistant message', async () => {
    const model = new MockLanguageModelV4({ doStream: [{ stream: streamOf(textStep('Hello')) }] })
    const transport = createChatTransport({
      getSettings: () => defaultSettings(),
      skillRegistry: new SkillRegistry(skillStore),
      toolRegistry: new ToolRegistry(),
      modelFactory: () => model,
      getConfig: () => defaultThreadConfig('p1', 'm1'),
    })

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'th1',
      messageId: undefined,
      messages: [user('u1', 'hi')],
      abortSignal: undefined,
    })

    let latest: UIMessage | undefined
    for await (const message of readUIMessageStream({ stream })) latest = message
    expect(latest).toBeDefined()
    const text = (latest?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
    expect(text).toBe('Hello')
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('resolves reconnectToStream to null', async () => {
    const transport = createChatTransport({
      getSettings: () => defaultSettings(),
      skillRegistry: new SkillRegistry(skillStore),
      toolRegistry: new ToolRegistry(),
      getConfig: () => defaultThreadConfig('p1', 'm1'),
    })
    await expect(transport.reconnectToStream({ chatId: 'th1' })).resolves.toBeNull()
  })
})
