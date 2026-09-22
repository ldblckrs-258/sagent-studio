import type { LanguageModel, UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../vault/settings'
import type { Settings } from '../vault/settings'
import {
  buildTitlePrompt,
  cleanTitle,
  countUserMessages,
  firstAssistantText,
  firstUserText,
  formatTranscript,
  generateConversationTitle,
  RENAME_EVERY_USER_MESSAGES,
  shouldGenerateTitle,
  titleModel,
} from './title'
import type { ChatThread } from './types'
import { defaultThreadConfig } from './types'

function user(text: string): UIMessage {
  return { id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(text: string, id = `a-${text}`): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }], metadata: { chatStatus: 'done' } }
}

function thread(messages: UIMessage[], patch: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'th1',
    title: 'New chat',
    messages,
    config: defaultThreadConfig('p1', 'm1'),
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function reply(text: string): MockLanguageModelV4 {
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

function settings(patch: Partial<Settings> = {}): Settings {
  return {
    ...defaultSettings(),
    providers: [
      {
        id: 'p1',
        label: 'p1',
        kind: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        apiKey: 'k',
        models: [{ id: 'm1' }, { id: 'sub' }],
        defaultModel: 'm1',
      },
    ],
    ...patch,
  }
}

describe('cleanTitle', () => {
  it('takes the first line and strips quotes, a Title label, and trailing punctuation', () => {
    expect(cleanTitle('"RAG Retry Fix."\nsecond line')).toBe('RAG Retry Fix')
    expect(cleanTitle('Title: Vector search')).toBe('Vector search')
  })

  it('clamps to the title limit', () => {
    expect(cleanTitle('x'.repeat(200)).length).toBe(80)
  })

  it('returns an empty string for blank input', () => {
    expect(cleanTitle('   \n\n')).toBe('')
  })
})

describe('message extraction', () => {
  it('reads the first user and first assistant text, skipping empty assistants', () => {
    const th = thread([
      assistant(''),
      user('How does the vault work?'),
      assistant('The vault derives a key from your password.'),
    ])
    expect(firstUserText(th)).toBe('How does the vault work?')
    expect(firstAssistantText(th)).toBe('The vault derives a key from your password.')
  })

  it('returns empty strings when a role is absent', () => {
    expect(firstUserText(thread([assistant('hi')]))).toBe('')
    expect(firstAssistantText(thread([user('hi')]))).toBe('')
  })
})

describe('titleModel', () => {
  it('prefers the configured cheap tier over the conversation model', () => {
    const factory = vi.fn((_s, providerId: string, modelId?: string) => ({
      providerId,
      modelId,
    })) as unknown as (s: Settings, p: string, m?: string) => LanguageModel
    titleModel(
      settings({ modelTiers: { cheap: { providerId: 'p1', modelId: 'sub' } } }),
      thread([]),
      factory,
    )
    expect(factory).toHaveBeenCalledWith(expect.anything(), 'p1', 'sub')
  })

  it("falls back to the conversation's own model when no cheap tier is set", () => {
    const factory = vi.fn((_s, providerId: string, modelId?: string) => ({
      providerId,
      modelId,
    })) as unknown as (s: Settings, p: string, m?: string) => LanguageModel
    titleModel(settings(), thread([]), factory)
    expect(factory).toHaveBeenCalledWith(expect.anything(), 'p1', 'm1')
  })
})

describe('generateConversationTitle', () => {
  it('returns a normalized title from the model reply', async () => {
    const model = reply('"Vault Key Derivation."')
    const title = await generateConversationTitle({
      settings: settings(),
      thread: thread([user('How does the vault work?'), assistant('It derives a key.')]),
      factory: () => model as unknown as LanguageModel,
    })
    expect(title).toBe('Vault Key Derivation')
  })

  it('returns null when there is no user text to name', async () => {
    const factory = vi.fn()
    const title = await generateConversationTitle({
      settings: settings(),
      thread: thread([assistant('hi')]),
      factory: factory as unknown as () => LanguageModel,
    })
    expect(title).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('returns null when the model echoes the placeholder title', async () => {
    const title = await generateConversationTitle({
      settings: settings(),
      thread: thread([user('hi')]),
      factory: () => reply('New chat') as unknown as LanguageModel,
    })
    expect(title).toBeNull()
  })

  it('requests a budget large enough for a reasoning model to finish', async () => {
    const model = reply('Vault Key Derivation')
    await generateConversationTitle({
      settings: settings(),
      thread: thread([user('hi')]),
      factory: () => model as unknown as LanguageModel,
    })
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBeGreaterThanOrEqual(512)
  })

  it('uses the configured cheap tier when one is set', async () => {
    const cheapReply = reply('Sub Model Title')
    const factory = vi.fn(() => cheapReply as unknown as LanguageModel)
    const title = await generateConversationTitle({
      settings: settings({ modelTiers: { cheap: { providerId: 'p1', modelId: 'sub' } } }),
      thread: thread([user('hi')]),
      factory,
    })
    expect(title).toBe('Sub Model Title')
    expect(factory).toHaveBeenCalledWith(expect.anything(), 'p1', 'sub')
  })
})

describe('buildTitlePrompt', () => {
  it('carries the transcript and instructs a title-only reply', () => {
    const prompt = buildTitlePrompt('User: q\nAssistant: a')
    expect(prompt).toContain('User: q')
    expect(prompt).toContain('Assistant: a')
    expect(prompt).toContain('Title:')
    expect(prompt).toContain('Answer immediately')
  })
})

describe('countUserMessages', () => {
  it('counts only user turns', () => {
    expect(countUserMessages(thread([user('a'), assistant('b'), user('c')]))).toBe(2)
  })
})

describe('shouldGenerateTitle', () => {
  it('names the first turn of a new conversation', () => {
    expect(shouldGenerateTitle(thread([user('hi')]))).toBe(true)
  })

  it('does not name a thread with no user turn', () => {
    expect(shouldGenerateTitle(thread([assistant('hi')]))).toBe(false)
  })

  it(`re-names on every ${RENAME_EVERY_USER_MESSAGES}th user turn after the first name`, () => {
    const many = (n: number): UIMessage[] =>
      Array.from({ length: n }, (_, index) => user(`q${index}`))
    expect(shouldGenerateTitle(thread(many(4), { title: 'Auto', titleSource: 'auto' }))).toBe(false)
    expect(shouldGenerateTitle(thread(many(5), { title: 'Auto', titleSource: 'auto' }))).toBe(true)
    expect(shouldGenerateTitle(thread(many(10), { title: 'Auto', titleSource: 'auto' }))).toBe(true)
  })

  it('never re-names a title the user set', () => {
    const many = Array.from({ length: 10 }, (_, index) => user(`q${index}`))
    expect(shouldGenerateTitle(thread(many, { title: 'Mine', titleSource: 'user' }))).toBe(false)
  })

  it('does not name the same turn twice', () => {
    const many = Array.from({ length: 5 }, (_, index) => user(`q${index}`))
    const t = thread(many, { title: 'Auto', titleSource: 'auto', titleUserCount: 5 })
    expect(shouldGenerateTitle(t)).toBe(false)
  })
})

describe('formatTranscript', () => {
  it('keeps only the most recent messages', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0 ? user(`q${index}`) : assistant(`a${index}`),
    )
    const transcript = formatTranscript(thread(messages))
    expect(transcript).toContain('q8')
    expect(transcript).not.toContain('q0')
  })

  it('is empty when there is nothing to read', () => {
    expect(formatTranscript(thread([]))).toBe('')
  })

  it('clamps a long single message to the per-message budget', () => {
    const transcript = formatTranscript(thread([user('x'.repeat(5000))]))
    expect(transcript.length).toBeLessThan(700)
  })
})
