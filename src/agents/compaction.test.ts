import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { compactPrefix, safeCutIndex } from './compaction'

function user(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistantText(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function assistantCall(id: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'read_file', input: {} }],
  }
}

function toolResult(id: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'read_file',
        output: { type: 'text', value: 'ok' },
      },
    ],
  }
}

function callIds(messages: readonly ModelMessage[], kind: 'tool-call' | 'tool-result'): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === kind) ids.push((part as { toolCallId: string }).toolCallId)
    }
  }
  return ids
}

function assertNoOrphans(messages: readonly ModelMessage[], cut: number): void {
  const head = messages.slice(0, cut)
  const tail = messages.slice(cut)
  expect(callIds(head, 'tool-call').sort()).toEqual(callIds(head, 'tool-result').sort())
  expect(callIds(tail, 'tool-call').sort()).toEqual(callIds(tail, 'tool-result').sort())
  expect(tail[0]?.role).not.toBe('tool')
}

function toolHeavy(steps: number): ModelMessage[] {
  const messages: ModelMessage[] = [user('task')]
  for (let index = 0; index < steps; index += 1) {
    messages.push(assistantCall(`c${index}`), toolResult(`c${index}`))
  }
  return messages
}

describe('safeCutIndex', () => {
  it('never separates a tool call from its result in a tool-heavy history', () => {
    for (let steps = 1; steps <= 12; steps += 1) {
      const messages = toolHeavy(steps)
      const cut = safeCutIndex(messages)
      if (cut > 0) assertNoOrphans(messages, cut)
    }
  })

  it('keeps at least the last two exchanges so the model still sees its recent work', () => {
    const messages = toolHeavy(6)
    const cut = safeCutIndex(messages)
    const kept = messages.slice(cut).filter((message) => message.role === 'assistant')

    expect(cut).toBeGreaterThan(0)
    expect(kept.length).toBeGreaterThanOrEqual(2)
  })

  it('cuts a text-only history before a user turn', () => {
    const messages = [
      user('a'),
      assistantText('1'),
      user('b'),
      assistantText('2'),
      user('c'),
      assistantText('3'),
    ]
    const cut = safeCutIndex(messages)

    expect(cut).toBeGreaterThan(0)
    expect(messages[cut].role).toBe('user')
    expect(messages.slice(cut).filter((message) => message.role === 'assistant')).toHaveLength(2)
  })

  it('refuses to cut a single exchange, since nothing older exists to summarize', () => {
    expect(safeCutIndex([user('task'), assistantCall('c1'), toolResult('c1')])).toBe(0)
    expect(safeCutIndex([user('task'), assistantText('done')])).toBe(0)
    expect(safeCutIndex([])).toBe(0)
  })

  it('never starts the kept tail with a second tool message of the same step', () => {
    const messages: ModelMessage[] = [
      user('task'),
      assistantCall('c1'),
      toolResult('c1'),
      toolResult('c1'),
      assistantCall('c2'),
      toolResult('c2'),
      assistantCall('c3'),
      toolResult('c3'),
    ]
    const cut = safeCutIndex(messages)

    expect(messages[cut]?.role).not.toBe('tool')
  })
})

describe('compactPrefix', () => {
  it('replaces the prefix with one summary turn that keeps the original task verbatim', () => {
    const messages = toolHeavy(4)
    const cut = safeCutIndex(messages)
    const compacted = compactPrefix(messages, 'did things', cut, 'task')

    expect(compacted[0]).toEqual({
      role: 'user',
      content: '<original-task>\ntask\n</original-task>\n\n<earlier-work-summary>\ndid things\n</earlier-work-summary>',
    })
    expect(compacted.slice(1)).toEqual(messages.slice(cut))
  })
})
