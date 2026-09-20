import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  contextTokensOf,
  estimateMessagesTokens,
  estimateTokens,
  outputCharsOf,
  totalTokensOf,
  turnUsageFrom,
  usageOf,
} from './usage'
import type { TurnUsage } from './usage'

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(id: string, text: string, usage?: TurnUsage): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    ...(usage ? { metadata: { chatStatus: 'done', usage } } : {}),
  }
}

describe('estimateTokens', () => {
  it('reads empty text as no tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('rounds a partial token up, so a short message is never free', () => {
    expect(estimateTokens('ab')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('estimateMessagesTokens', () => {
  it('counts the prose of every message, not just the last', () => {
    const messages = [user('u1', 'a'.repeat(8)), assistant('a1', 'b'.repeat(8))]
    expect(estimateMessagesTokens(messages)).toBe(4)
  })

  it('counts a tool call input and output, because the request carries both', () => {
    const withTool: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-read_file',
          toolCallId: 't1',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: { text: 'x'.repeat(40) },
        } as unknown as UIMessage['parts'][number],
      ],
    }
    const proseOnly = estimateMessagesTokens([assistant('a2', '')])
    expect(estimateMessagesTokens([withTool])).toBeGreaterThan(proseOnly + 10)
  })

  it('ignores a part the model never receives', () => {
    const withFile: UIMessage = {
      id: 'u1',
      role: 'user',
      parts: [
        {
          type: 'file',
          mediaType: 'image/png',
          url: `data:image/png;base64,${'A'.repeat(400)}`,
        } as unknown as UIMessage['parts'][number],
      ],
    }
    expect(estimateMessagesTokens([withFile])).toBe(0)
  })
})

describe('outputCharsOf', () => {
  it('sums text and reasoning, so the live rate tracks everything streamed', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'abc' } as unknown as UIMessage['parts'][number],
        { type: 'text', text: 'defg' },
      ],
    }
    expect(outputCharsOf(message)).toBe(7)
  })
})

describe('turnUsageFrom', () => {
  it('derives the total and the rate from the provider counts', () => {
    const usage = turnUsageFrom({ inputTokens: 100, outputTokens: 50 }, 2000)
    expect(usage.totalTokens).toBe(150)
    expect(usage.tokensPerSecond).toBe(25)
    expect(usage.estimated).toBe(false)
  })

  it('keeps the provider total when it disagrees with the sum', () => {
    const usage = turnUsageFrom(
      { inputTokens: 10, outputTokens: 5, totalTokens: 21 },
      1000,
    )
    expect(usage.totalTokens).toBe(21)
  })

  it('records no token fields and flags itself when the provider omits usage', () => {
    const usage = turnUsageFrom(undefined, 500)
    expect(usage.estimated).toBe(true)
    expect(usage.inputTokens).toBeUndefined()
    expect(usage.outputTokens).toBeUndefined()
    expect(usage.totalTokens).toBeUndefined()
    expect(usage.durationMs).toBe(500)
  })

  it('omits the rate when no time elapsed, rather than dividing by zero', () => {
    const usage = turnUsageFrom({ outputTokens: 10 }, 0)
    expect(usage.tokensPerSecond).toBeUndefined()
  })
})

describe('usageOf', () => {
  it('is undefined for a turn that recorded none', () => {
    expect(usageOf(assistant('a1', 'hi'))).toBeUndefined()
  })
})

describe('totalTokensOf', () => {
  it('sums every recorded turn so the thread total grows with the conversation', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', 'one', turnUsageFrom({ inputTokens: 10, outputTokens: 5 }, 100)),
      user('u2', 'again'),
      assistant('a2', 'two', turnUsageFrom({ inputTokens: 30, outputTokens: 7 }, 100)),
    ]
    expect(totalTokensOf(messages)).toBe(52)
  })

  it('is zero when no turn recorded usage', () => {
    expect(totalTokensOf([user('u1', 'hi'), assistant('a1', 'yo')])).toBe(0)
  })
})

describe('contextTokensOf', () => {
  it('prefers the last assistant turn’s measured input plus output', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', 'one', turnUsageFrom({ inputTokens: 10, outputTokens: 5 }, 100)),
      user('u2', 'again'),
      assistant('a2', 'two', turnUsageFrom({ inputTokens: 900, outputTokens: 100 }, 100)),
    ]
    expect(contextTokensOf(messages)).toEqual({ tokens: 1000, estimated: false })
  })

  it('falls back to a flagged estimate when the provider omitted usage', () => {
    const messages = [
      user('u1', 'a'.repeat(20)),
      assistant('a1', 'b'.repeat(20), turnUsageFrom(undefined, 100)),
    ]
    const context = contextTokensOf(messages)
    expect(context.estimated).toBe(true)
    expect(context.tokens).toBe(10)
  })

  it('estimates while a run is in flight, because the placeholder has no usage yet', () => {
    const messages = [
      user('u1', 'a'.repeat(8)),
      assistant('a1', 'done', turnUsageFrom({ inputTokens: 900 }, 100)),
      user('u2', 'b'.repeat(8)),
      { id: 'a2', role: 'assistant', parts: [], metadata: { chatStatus: 'streaming' } },
    ] satisfies UIMessage[]
    expect(contextTokensOf(messages).estimated).toBe(true)
  })

  it('estimates an empty thread as zero rather than reporting a measured zero', () => {
    expect(contextTokensOf([])).toEqual({ tokens: 0, estimated: true })
  })

  it('does not look past the newest assistant turn for an older measurement', () => {
    const messages = [
      assistant('a1', 'old', turnUsageFrom({ inputTokens: 5000 }, 100)),
      user('u1', 'hi'),
      assistant('a2', 'new'),
    ]
    const context = contextTokensOf(messages)
    expect(context.estimated).toBe(true)
    expect(context.tokens).toBeLessThan(100)
  })
})

describe('multi-step turns', () => {
  it('measures context from the final step, not the summed prompts', () => {
    // A two-step tool turn: step prompts were 10 and 20, so the provider's
    // `totalUsage.inputTokens` is 30. Only the final step's 20 describes the
    // conversation; 30 counts it twice.
    const usage = turnUsageFrom(
      { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      1000,
      { inputTokens: 20, outputTokens: 7 },
    )
    expect(usage.contextTokens).toBe(27)
    expect(usage.totalTokens).toBe(42)
  })

  it('keeps the rate on the turn’s whole output', () => {
    const usage = turnUsageFrom({ outputTokens: 12 }, 2000, { outputTokens: 7 })
    expect(usage.tokensPerSecond).toBe(6)
  })

  it('reads a single-step turn exactly as before', () => {
    const usage = turnUsageFrom({ inputTokens: 10, outputTokens: 5 }, 1000)
    expect(usage.contextTokens).toBe(15)
  })

  it('reports the final step’s size as the context, not the inflated sum', () => {
    const messages = [
      user('u1', 'hi'),
      assistant(
        'a1',
        'done',
        turnUsageFrom({ inputTokens: 30, outputTokens: 12 }, 1000, {
          inputTokens: 20,
          outputTokens: 7,
        }),
      ),
    ]
    expect(contextTokensOf(messages)).toEqual({ tokens: 27, estimated: false })
  })
})

describe('contextTokensOf across a compaction boundary', () => {
  function boundary(id: string, text: string): UIMessage {
    return {
      id,
      role: 'assistant',
      parts: [{ type: 'text', text }],
      metadata: {
        chatStatus: 'done',
        compaction: { at: 1, replacedCount: 2, tokensBefore: 5000 },
      },
    }
  }

  it('estimates only the messages the request will actually send', () => {
    // Without slicing at the boundary this estimates the whole thread, so
    // compaction would never lower the number that triggered it and every
    // later turn would compact again.
    const messages = [
      user('u1', 'a'.repeat(4000)),
      assistant('a1', 'b'.repeat(4000)),
      boundary('b1', 'short summary'),
    ]
    const context = contextTokensOf(messages)
    expect(context.estimated).toBe(true)
    expect(context.tokens).toBeLessThan(100)
  })

  it('drops far below the pre-compaction size, so compaction has an effect', () => {
    const history = [user('u1', 'a'.repeat(8000)), assistant('a1', 'b'.repeat(8000))]
    const before = contextTokensOf(history).tokens
    const after = contextTokensOf([...history, boundary('b1', 'short summary')]).tokens
    expect(before).toBeGreaterThan(3000)
    expect(after).toBeLessThan(before / 10)
  })

  it('ignores a measured turn from before the boundary', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', 'big', turnUsageFrom({ inputTokens: 90_000 }, 1000)),
      boundary('b1', 'short summary'),
    ]
    expect(contextTokensOf(messages).tokens).toBeLessThan(100)
  })

  it('prefers a measured turn recorded after the boundary', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', 'big', turnUsageFrom({ inputTokens: 90_000 }, 1000)),
      boundary('b1', 'short summary'),
      user('u2', 'next'),
      assistant('a2', 'fresh', turnUsageFrom({ inputTokens: 400, outputTokens: 20 }, 1000)),
    ]
    expect(contextTokensOf(messages)).toEqual({ tokens: 420, estimated: false })
  })
})

describe('contextTokensOf after a boundary plus a full turn', () => {
  it('uses the measured turn recorded after the boundary, not an estimate', () => {
    const messages: UIMessage[] = [
      user('u1', 'a'.repeat(4000)),
      {
        id: 'b1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'summary' }],
        metadata: {
          chatStatus: 'done',
          compaction: { at: 1, replacedCount: 1, tokensBefore: 1000 },
        },
      },
      user('u2', 'next'),
      assistant('a2', 'answer', turnUsageFrom({ inputTokens: 300, outputTokens: 40 }, 1000)),
    ]
    expect(contextTokensOf(messages)).toEqual({ tokens: 340, estimated: false })
  })
})
