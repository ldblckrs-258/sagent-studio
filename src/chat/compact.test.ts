import type { LanguageModel, UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../vault/settings'
import { SkillRegistry } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import {
  compactThread,
  findBoundaryIndex,
  messagesSinceBoundary,
  splitTrailingUserTurn,
  summarizeMessages,
} from './compact'
import type { PipelineDeps } from './engine'
import type { ChatThread } from './types'
import { defaultThreadConfig } from './types'
import { turnUsageFrom } from './usage'

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(id: string, text: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: { chatStatus: 'done' },
  }
}

function boundary(id: string, text: string, replacedCount = 2): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: {
      chatStatus: 'done',
      compaction: { at: 1, replacedCount, tokensBefore: 100 },
    },
  }
}

function summarizer(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: text.length > 0 ? [{ type: 'text' as const, text }] : [],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  })
}

function failing(message: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(message)
    },
  })
}

function deps(model: LanguageModel): PipelineDeps {
  return {
    getSettings: () => defaultSettings(),
    skillRegistry: new SkillRegistry({
      save: async () => {},
      remove: async () => {},
      list: async () => [],
    }),
    toolRegistry: new ToolRegistry(),
    modelFactory: () => model,
  }
}

function thread(messages: UIMessage[]): ChatThread {
  return {
    id: 'th1',
    title: 'Thread',
    messages,
    config: defaultThreadConfig('p1', 'm1'),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('findBoundaryIndex', () => {
  it('reports -1 for a thread that has never been compacted', () => {
    expect(findBoundaryIndex([user('u1', 'hi'), assistant('a1', 'yo')])).toBe(-1)
  })

  it('reports the newest boundary when there are several', () => {
    const messages = [
      user('u1', 'hi'),
      boundary('b1', 'first summary'),
      user('u2', 'more'),
      boundary('b2', 'second summary'),
      user('u3', 'again'),
    ]
    expect(findBoundaryIndex(messages)).toBe(3)
  })
})

describe('messagesSinceBoundary', () => {
  it('returns the whole thread when there is no boundary', () => {
    const messages = [user('u1', 'hi'), assistant('a1', 'yo')]
    expect(messagesSinceBoundary(messages).map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('keeps the boundary itself, because it carries the replaced history', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', 'yo'),
      boundary('b1', 'summary'),
      user('u2', 'next'),
    ]
    expect(messagesSinceBoundary(messages).map((m) => m.id)).toEqual(['b1', 'u2'])
  })

  it('starts from the newest boundary, dropping an older summary', () => {
    const messages = [
      boundary('b1', 'first'),
      user('u2', 'more'),
      boundary('b2', 'second'),
      user('u3', 'again'),
    ]
    expect(messagesSinceBoundary(messages).map((m) => m.id)).toEqual(['b2', 'u3'])
  })
})

describe('splitTrailingUserTurn', () => {
  it('separates the pending question from the history to summarize', () => {
    const messages = [user('u1', 'hi'), assistant('a1', 'yo'), user('u2', 'next')]
    const { history, tail } = splitTrailingUserTurn(messages)
    expect(history.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(tail.map((m) => m.id)).toEqual(['u2'])
  })

  it('takes every trailing user message, so an edited turn is not split apart', () => {
    const messages = [assistant('a1', 'yo'), user('u1', 'one'), user('u2', 'two')]
    expect(splitTrailingUserTurn(messages).tail.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('leaves an empty tail when the thread ends on an assistant turn', () => {
    const { history, tail } = splitTrailingUserTurn([user('u1', 'hi'), assistant('a1', 'yo')])
    expect(tail).toEqual([])
    expect(history).toHaveLength(2)
  })
})

describe('summarizeMessages', () => {
  it('summarizes through the thread’s own provider and model', async () => {
    const model = summarizer('BRIEFING')
    const modelFactory = vi.fn(() => model as LanguageModel)
    const summary = await summarizeMessages(
      { ...deps(model), modelFactory },
      defaultThreadConfig('p1', 'm1'),
      [user('u1', 'hi'), assistant('a1', 'yo')],
    )
    expect(summary).toBe('BRIEFING')
    expect(modelFactory).toHaveBeenCalledWith(expect.anything(), 'p1', 'm1')
  })

  it('carries the conversation and the focus instructions into the request', async () => {
    const model = summarizer('BRIEFING')
    await summarizeMessages(
      deps(model),
      defaultThreadConfig('p1', 'm1'),
      [user('u1', 'MARKER_ONE'), assistant('a1', 'MARKER_TWO')],
      'keep the API notes',
    )
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain('MARKER_ONE')
    expect(prompt).toContain('MARKER_TWO')
    expect(prompt).toContain('keep the API notes')
  })

  it('rejects an empty summary rather than hiding history behind nothing', async () => {
    await expect(
      summarizeMessages(deps(summarizer('   ')), defaultThreadConfig('p1', 'm1'), [
        user('u1', 'hi'),
      ]),
    ).rejects.toThrow(/empty summary/)
  })

  it('refuses to summarize while the vault is locked', async () => {
    await expect(
      summarizeMessages(
        { ...deps(summarizer('x')), getSettings: () => null },
        defaultThreadConfig('p1', 'm1'),
        [user('u1', 'hi')],
      ),
    ).rejects.toThrow(/vault is locked/)
  })
})

describe('compactThread', () => {
  it('appends a boundary and keeps every original message', async () => {
    const original = [user('u1', 'hi'), assistant('a1', 'yo')]
    const compacted = await compactThread(deps(summarizer('BRIEFING')), thread(original))

    expect(compacted.messages).toHaveLength(3)
    expect(compacted.messages.slice(0, 2)).toEqual(original)
    const meta = compacted.messages[2].metadata as {
      compaction?: { replacedCount: number }
    }
    expect(meta.compaction?.replacedCount).toBe(2)
    expect(messagesSinceBoundary(compacted.messages)).toHaveLength(1)
  })

  it('records the measured context size the boundary replaced', async () => {
    const original = [
      user('u1', 'hi'),
      {
        ...assistant('a1', 'yo'),
        metadata: {
          chatStatus: 'done' as const,
          usage: turnUsageFrom({ inputTokens: 900, outputTokens: 100 }, 1000),
        },
      },
    ]
    const compacted = await compactThread(deps(summarizer('BRIEFING')), thread(original))
    const meta = compacted.messages[2].metadata as {
      compaction?: { tokensBefore: number }
    }
    expect(meta.compaction?.tokensBefore).toBe(1000)
  })

  it('stores the focus instructions on the boundary', async () => {
    const compacted = await compactThread(
      deps(summarizer('BRIEFING')),
      thread([user('u1', 'hi')]),
      '  keep the API notes  ',
    )
    const meta = compacted.messages[1].metadata as {
      compaction?: { instructions?: string }
    }
    expect(meta.compaction?.instructions).toBe('keep the API notes')
  })

  it('leaves the thread untouched when the summary call fails', async () => {
    const original = [user('u1', 'hi'), assistant('a1', 'yo')]
    const before = thread(original)
    const snapshot = JSON.stringify(before)

    await expect(compactThread(deps(failing('provider down')), before)).rejects.toThrow(
      /provider down/,
    )
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(before.messages).toHaveLength(2)
  })

  it('summarizes only the messages after the previous boundary', async () => {
    const model = summarizer('SECOND')
    const messages = [
      user('u1', 'OLD_MARKER'),
      boundary('b1', 'FIRST_SUMMARY'),
      user('u2', 'NEW_MARKER'),
    ]
    const compacted = await compactThread(deps(model), thread(messages))

    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).not.toContain('OLD_MARKER')
    expect(prompt).toContain('FIRST_SUMMARY')
    expect(prompt).toContain('NEW_MARKER')
    expect(compacted.messages).toHaveLength(4)
    const meta = compacted.messages[3].metadata as {
      compaction?: { replacedCount: number }
    }
    expect(meta.compaction?.replacedCount).toBe(2)
  })

  it('refuses to compact an empty conversation', async () => {
    await expect(compactThread(deps(summarizer('x')), thread([]))).rejects.toThrow(
      /nothing to compact/,
    )
  })
})
