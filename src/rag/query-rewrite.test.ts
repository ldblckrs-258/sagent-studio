import type { LanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { buildQueryRewritePrompt, rewriteQuery } from './query-rewrite'

function reply(text: string): LanguageModel {
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
  }) as unknown as LanguageModel
}

describe('buildQueryRewritePrompt', () => {
  it('includes the query and the one-line instruction', () => {
    const prompt = buildQueryRewritePrompt('luat ngay phap luat')
    expect(prompt).toContain('Query: luat ngay phap luat')
    expect(prompt).toContain('Rewritten query:')
  })

  it('adds conversation context only when provided and non-blank', () => {
    expect(buildQueryRewritePrompt('q')).not.toContain('Conversation context:')
    expect(buildQueryRewritePrompt('q', '   ')).not.toContain('Conversation context:')
    expect(buildQueryRewritePrompt('q', 'the prior turn')).toContain(
      'Conversation context: the prior turn',
    )
  })
})

describe('rewriteQuery', () => {
  it('returns the first non-empty line, trimmed', async () => {
    expect(await rewriteQuery(reply('\n  better query terms  \nignored'), 'q')).toBe(
      'better query terms',
    )
  })

  it('returns an empty string when the model replies with nothing usable', async () => {
    expect(await rewriteQuery(reply('   '), 'q')).toBe('')
  })

  it('propagates a model failure so the caller can fall back', async () => {
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('boom')
      },
    }) as unknown as LanguageModel
    await expect(rewriteQuery(failing, 'q')).rejects.toThrow('boom')
  })
})
