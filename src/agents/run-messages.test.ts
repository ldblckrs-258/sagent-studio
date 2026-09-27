import { describe, expect, it } from 'vitest'
import { normalizeThreadMessages, uiMessagesFromEvents } from './run-messages'

const textOf = (message: { parts: readonly { type: string; text?: string }[] }): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')

describe('uiMessagesFromEvents', () => {
  it('coalesces consecutive text deltas into one markdown block', () => {
    const messages = uiMessagesFromEvents('run-1', 'go', [
      { type: 'text-delta', text: 'Workspace' },
      { type: 'text-delta', text: ' Structural' },
      { type: 'text-delta', text: ' Summary' },
    ])

    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(textOf(assistant!)).toBe('Workspace Structural Summary')
  })

  it('marks a tool call complete and carries its result once it arrives', () => {
    const messages = uiMessagesFromEvents('run-1', 'go', [
      { type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', input: {} },
      {
        type: 'tool-result',
        toolName: 'list_dir',
        toolCallId: 'c1',
        output: { ok: true, code: 'ok', value: { entries: ['a.ts'] } },
      },
    ])

    const part = messages[1]?.parts.find((candidate) => candidate.type === 'dynamic-tool') as {
      state?: string
      output?: unknown
    }
    expect(part.state).toBe('output-available')
    expect(part.output).toEqual({ ok: true, code: 'ok', value: { entries: ['a.ts'] } })
  })

  it('falls back to an empty result when the event carried none', () => {
    const messages = uiMessagesFromEvents('run-1', 'go', [
      { type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', input: {} },
      { type: 'tool-result', toolName: 'list_dir', toolCallId: 'c1' },
    ])

    const part = messages[1]?.parts.find((candidate) => candidate.type === 'dynamic-tool') as {
      state?: string
      output?: unknown
    }
    expect(part.state).toBe('output-available')
    expect(part.output).toEqual({})
  })

  it('closes an unresolved tool call on a settled run', () => {
    const messages = uiMessagesFromEvents(
      'run-1',
      'go',
      [{ type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', input: {} }],
      true,
    )

    const part = messages[1]?.parts.find((candidate) => candidate.type === 'dynamic-tool') as {
      state?: string
    }
    expect(part.state).toBe('output-available')
  })

  it('splits assistant turns around a steering message', () => {
    const messages = uiMessagesFromEvents('run-1', 'go', [
      { type: 'text-delta', text: 'first' },
      { type: 'user-message', text: 'keep going' },
      { type: 'text-delta', text: 'second' },
    ])

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(textOf(messages[3]!)).toBe('second')
  })
})

describe('normalizeThreadMessages', () => {
  it('repairs a legacy transcript with per-chunk text and an open tool call', () => {
    const normalized = normalizeThreadMessages([
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'one ' },
          { type: 'text', text: 'two' },
          {
            type: 'dynamic-tool',
            toolName: 'list_dir',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
          } as never,
        ],
      },
    ])

    expect(textOf(normalized[0]!)).toBe('one two')
    const part = normalized[0]!.parts.find((candidate) => candidate.type === 'dynamic-tool') as {
      output?: unknown
    }
    expect(part.output).toEqual({})
  })
})
