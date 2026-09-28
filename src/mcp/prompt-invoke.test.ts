import { describe, expect, it, vi } from 'vitest'
import { ChatError } from '../chat/errors'
import { defaultSlashEntries, resolveSlash, runSlashCommand } from '../chat/slash'
import type { SlashContext } from '../chat/slash'
import { defaultThreadConfig } from '../chat/types'
import type { AppSession } from '../session/session'
import { SkillRegistry } from '../skills/registry'
import { McpConnectionManager, emptyCatalog } from './manager'
import {
  mcpPromptEntries,
  mcpPromptId,
  parsePromptArguments,
  promptResultText,
} from './prompt-invoke'
import { memoryPersistence, serverConfig } from './test-fixtures'

function skills(ids: string[] = []): SkillRegistry {
  const registry = new SkillRegistry({ save: async () => {}, remove: async () => {}, list: async () => [] })
  for (const id of ids) {
    registry.register(
      { id, name: id, description: '', instructions: '', allowedTools: [], source: 'vault' },
      { enabled: true },
    )
  }
  return registry
}

async function readyManager(prompts = [
  { name: 'summarize', description: 'Summarize a doc', arguments: [{ name: 'topic', required: true }] },
  { name: 'triage', arguments: [{ name: 'team', required: true }, { name: 'limit' }] },
  { name: 'compact' },
]) {
  const manager = new McpConnectionManager({
    persistence: memoryPersistence([serverConfig({ name: 'Linear', enabled: false })]),
  })
  await manager.hydrate()
  manager.store.setState((state) => ({
    servers: {
      ...state.servers,
      mcp_one: { ...state.servers.mcp_one!, state: 'ready', catalog: { ...emptyCatalog(), prompts } },
    },
  }))
  return manager
}

function context(sendTurn = vi.fn(async () => {})): { ctx: SlashContext; sendTurn: typeof sendTurn } {
  const session = { engineFor: () => ({ sendTurn }) } as unknown as AppSession
  return {
    sendTurn,
    ctx: {
      session,
      threadId: 'th1',
      thread: {
        id: 'th1',
        title: 't',
        messages: [],
        config: defaultThreadConfig('p1', 'm1'),
        createdAt: 1,
        updatedAt: 1,
      },
    },
  }
}

describe('mcpPromptId', () => {
  it('fits the slash command shape', () => {
    expect(mcpPromptId('My Server', 'summarize doc/v2')).toBe('my_server.summarize-doc-v2')
  })
})

describe('parsePromptArguments', () => {
  it('gives a single-argument prompt the whole trailing text', () => {
    expect(
      parsePromptArguments({ name: 'p', arguments: [{ name: 'topic', required: true }] }, ' the Q3 plan '),
    ).toEqual({ args: { topic: 'the Q3 plan' }, extra: '' })
  })

  it('parses name=value pairs with quotes for several arguments', () => {
    expect(
      parsePromptArguments(
        { name: 'p', arguments: [{ name: 'team', required: true }, { name: 'note' }] },
        `team=core note="two words"`,
      ).args,
    ).toEqual({ team: 'core', note: 'two words' })
  })

  it('refuses before sending when a required argument is missing or unknown', () => {
    const prompt = { name: 'p', arguments: [{ name: 'team', required: true }, { name: 'limit' }] }
    expect(() => parsePromptArguments(prompt, 'limit=3')).toThrow(/needs team/)
    expect(() => parsePromptArguments(prompt, 'team=a owner=b')).toThrow(/no argument "owner"/)
    expect(() => parsePromptArguments(prompt, 'core')).toThrow(/name=value/)
    expect(() => parsePromptArguments({ name: 'q', arguments: [{ name: 'x', required: true }] }, '')).toThrow(
      ChatError,
    )
  })

  it('keeps text typed after a prompt without arguments as extra context', () => {
    expect(parsePromptArguments({ name: 'p' }, 'also check X')).toEqual({ args: {}, extra: 'also check X' })
  })
})

describe('promptResultText', () => {
  it('flattens prompt messages into one user turn and marks assistant turns', () => {
    expect(
      promptResultText({
        messages: [
          { role: 'user', content: { type: 'text', text: 'Review this' } },
          { role: 'user', content: { type: 'resource', resource: { uri: 'file:///a', text: 'body' } } },
          { role: 'assistant', content: { type: 'text', text: 'Sure' } },
          { role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        ],
      }),
    ).toBe('Review this\n\n```\nbody\n```\n\nAssistant: Sure\n\n[image, image/png]')
  })
})

describe('MCP prompts as slash commands', () => {
  it('lists prompts from ready servers and prefixes one that collides with a built-in or skill', async () => {
    const manager = await readyManager()
    const entries = defaultSlashEntries(skills(['linear.triage']), manager)
    const ids = entries.map((entry) => entry.id)
    expect(ids).toContain('linear.summarize')
    expect(ids).toContain('mcp.linear.triage')
    expect(ids).toContain('linear.compact')
    const summarize = entries.find((entry) => entry.id === 'linear.summarize')!
    expect(summarize.kind).toBe('mcp-prompt')
    expect(summarize.argumentHint).toBe('<topic>')
    expect(summarize.description).toBe('[MCP: Linear] Summarize a doc')
    expect(resolveSlash(entries, 'mcp.linear.triage')?.kind).toBe('mcp-prompt')
    expect(resolveSlash(entries, 'linear.triage')?.kind).toBe('skill')
    await manager.dispose()
  })

  it('hides prompts from servers that are not ready', async () => {
    const manager = await readyManager()
    manager.store.setState((state) => ({
      servers: { ...state.servers, mcp_one: { ...state.servers.mcp_one!, state: 'error' } },
    }))
    expect(mcpPromptEntries(manager)).toEqual([])
    await manager.dispose()
  })

  it('fetches the prompt with parsed arguments and sends its text as the user turn', async () => {
    const manager = await readyManager()
    const getPrompt = vi.spyOn(manager, 'getPrompt').mockResolvedValue({
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize Q3' } }],
    })
    const { ctx, sendTurn } = context()
    await runSlashCommand(defaultSlashEntries(skills(), manager), ctx, '/linear.summarize Q3')
    expect(getPrompt).toHaveBeenCalledWith('mcp_one', 'summarize', { topic: 'Q3' })
    expect(sendTurn).toHaveBeenCalledWith('th1', 'Summarize Q3')
    await manager.dispose()
  })

  it('reports a server failure as a chat error and sends nothing', async () => {
    const manager = await readyManager()
    vi.spyOn(manager, 'getPrompt').mockRejectedValue(new TypeError('Failed to fetch'))
    const { ctx, sendTurn } = context()
    await expect(
      runSlashCommand(defaultSlashEntries(skills(), manager), ctx, '/linear.summarize Q3'),
    ).rejects.toThrow(/could not reach the server/)
    expect(sendTurn).not.toHaveBeenCalled()
    await manager.dispose()
  })
})
