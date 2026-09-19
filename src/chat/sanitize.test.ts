import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { rehydrateThread, sanitizePartial, setChatStatus } from './sanitize'
import { defaultThreadConfig } from './types'
import type { ChatThread } from './types'

function assistant(parts: UIMessage['parts'], metadata?: unknown): UIMessage {
  return { id: 'a1', role: 'assistant', parts, ...(metadata === undefined ? {} : { metadata }) }
}

function thread(message: UIMessage): ChatThread {
  return {
    id: 'th1',
    title: 'Thread',
    messages: [message],
    config: defaultThreadConfig('p1'),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('sanitizePartial', () => {
  it('marks a non-terminal tool part as an output error and drops its output', () => {
    const message = assistant([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        state: 'input-available',
        input: { value: 1 },
        output: { stale: true },
      } as unknown as UIMessage['parts'][number],
    ])

    const sanitized = sanitizePartial(message)
    const part = sanitized.parts[0] as unknown as Record<string, unknown>
    expect(part.state).toBe('output-error')
    expect(part.output).toBeUndefined()
    expect(typeof part.errorText).toBe('string')
  })

  it('leaves a terminal tool part untouched', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 'c1',
      state: 'output-available',
      input: { value: 1 },
      output: { ok: true },
    } as unknown as UIMessage['parts'][number]
    const sanitized = sanitizePartial(assistant([part]))
    expect(sanitized.parts[0]).toEqual(part)
  })

  it('sets chatStatus to done', () => {
    const sanitized = sanitizePartial(assistant([{ type: 'text', text: 'hi' }]))
    expect(sanitized.metadata).toMatchObject({ chatStatus: 'done' })
  })
})

describe('setChatStatus', () => {
  it('preserves other metadata fields', () => {
    const next = setChatStatus(assistant([{ type: 'text', text: 'x' }], { other: 1 }), 'streaming')
    expect(next.metadata).toMatchObject({ other: 1, chatStatus: 'streaming' })
  })
})

describe('rehydrateThread', () => {
  it('sanitizes a streaming assistant message', () => {
    const rehydrated = rehydrateThread(
      thread(assistant([{ type: 'text', text: 'partial' }], { chatStatus: 'streaming' })),
    )
    expect(rehydrated.messages[0].metadata).toMatchObject({ chatStatus: 'done' })
  })

  it('sanitizes a non-terminal tool part even without a streaming status', () => {
    const message = assistant([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        state: 'input-available',
        input: {},
      } as unknown as UIMessage['parts'][number],
    ])
    const rehydrated = rehydrateThread(thread(message))
    const part = rehydrated.messages[0].parts[0] as unknown as Record<string, unknown>
    expect(part.state).toBe('output-error')
  })

  it('leaves a clean thread unchanged', () => {
    const message = assistant([{ type: 'text', text: 'done' }], { chatStatus: 'done' })
    const original = thread(message)
    const rehydrated = rehydrateThread(original)
    expect(rehydrated.messages).toEqual(original.messages)
  })
})
