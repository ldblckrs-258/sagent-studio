import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  appendMessage,
  baseForMessage,
  canRerun,
  canUndo,
  deleteMessage,
  editMessage,
  truncateAfter,
  truncateBefore,
  undoLastTurn,
} from './reducer'

function user(id: string, text = id): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(id: string, text = id): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

function conversation(): UIMessage[] {
  return [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
}

describe('chat reducer', () => {
  it('appends without mutating the input', () => {
    const messages = [user('u1')]
    const next = appendMessage(messages, assistant('a1'))
    expect(next.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(messages).toHaveLength(1)
    expect(next).not.toBe(messages)
  })

  it('drops attachment records when an edit replaces the parts', () => {
    // The inlined block is gone after an edit, so a surviving record would let
    // the next turn claim the content is already in the conversation.
    const withRecords: UIMessage = {
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: 'look' }],
      metadata: {
        chatStatus: 'done',
        attachments: [{ path: 'a.ts', hash: 'deadbeef', mode: 'inline' }],
      },
    } as UIMessage
    const next = editMessage([user('u1'), withRecords], 'u2', [
      { type: 'text', text: 'edited' },
    ])
    const metadata = next[1].metadata as Record<string, unknown>
    expect(metadata.attachments).toBeUndefined()
    expect(metadata.chatStatus).toBe('done')
  })

  it('edits a user message and truncates the downstream history', () => {
    const messages = conversation()
    const next = editMessage(messages, 'u2', [{ type: 'text', text: 'edited' }])
    expect(next.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(next[2].parts).toEqual([{ type: 'text', text: 'edited' }])
    expect(messages).toHaveLength(4)
  })

  it('edits an assistant message and truncates the downstream history', () => {
    const messages = conversation()
    const next = editMessage(messages, 'a1', [{ type: 'text', text: 'redone' }])
    expect(next.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(next[1].parts).toEqual([{ type: 'text', text: 'redone' }])
  })

  it('builds a rerun base from a middle assistant message parent', () => {
    const messages = conversation()
    expect(baseForMessage(messages, 'a2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(baseForMessage(messages, 'a1').map((m) => m.id)).toEqual(['u1'])
  })

  it('uses the user message itself as the rerun base', () => {
    const messages = conversation()
    expect(baseForMessage(messages, 'u2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('deletes only the targeted message', () => {
    const messages = conversation()
    const next = deleteMessage(messages, 'a1')
    expect(next.map((m) => m.id)).toEqual(['u1', 'u2', 'a2'])
    expect(messages).toHaveLength(4)
  })

  it('truncates the history after a message inclusive', () => {
    const messages = conversation()
    expect(truncateAfter(messages, 'a1').map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('cuts the rewound message and everything after it', () => {
    const messages = conversation()
    expect(truncateBefore(messages, 'u2').map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(truncateBefore(messages, 'u1')).toEqual([])
    expect(messages).toHaveLength(4)
  })

  it('leaves the thread unchanged when the rewound message is gone', () => {
    const messages = conversation()
    expect(truncateBefore(messages, 'missing')).toBe(messages)
  })

  it('undoes a completed turn by cutting from the last user message', () => {
    expect(undoLastTurn(conversation()).map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('undoes a trailing user message with no assistant reply', () => {
    const messages = [user('u1'), assistant('a1'), user('u2')]
    expect(undoLastTurn(messages).map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('is a no-op when there is no user turn to undo', () => {
    const messages = [assistant('a1')]
    expect(undoLastTurn(messages)).toBe(messages)
  })

  it('treats unknown ids as a no-op for every reducer operation', () => {
    const messages = conversation()
    expect(editMessage(messages, 'nope', [])).toBe(messages)
    expect(deleteMessage(messages, 'nope')).toBe(messages)
    expect(truncateAfter(messages, 'nope')).toBe(messages)
    expect(baseForMessage(messages, 'nope')).toBe(messages)
  })

  it('reports undo and rerun availability', () => {
    const messages = conversation()
    expect(canUndo(messages)).toBe(true)
    expect(canUndo([assistant('a1')])).toBe(false)
    expect(canRerun(messages, 'a1')).toBe(true)
    expect(canRerun(messages, 'u1')).toBe(false)
    expect(canRerun(messages, 'nope')).toBe(false)
  })

  it('does not rerun an orphaned assistant message without a parent user', () => {
    const messages = [assistant('a1')]
    expect(canRerun(messages, 'a1')).toBe(false)
    expect(baseForMessage(messages, 'a1')).toEqual([])
  })
})
