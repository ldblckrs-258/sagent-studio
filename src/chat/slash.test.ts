import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillManifest } from '../skills/schema'
import type { AppSession } from '../session/session'
import {
  BUILTIN_SLASH_COMMANDS,
  looksLikeSlashCommand,
  parseSlashInput,
  resolveSlash,
  runSlashCommand,
  slashEntries,
} from './slash'
import type { SlashCommand, SlashContext } from './slash'
import type { ChatThread } from './types'
import { defaultThreadConfig } from './types'

function manifest(
  id: string,
  source: 'vault' | 'workspace',
  name = id,
): SkillManifest {
  return {
    id,
    name,
    description: `${id} does a thing`,
    instructions: 'INSTRUCTIONS_BODY',
    allowedTools: [],
    source,
  }
}

function registryWith(
  manifests: readonly SkillManifest[],
  disabled: readonly string[] = [],
): SkillRegistry {
  const registry = new SkillRegistry({
    save: async () => {},
    remove: async () => {},
    list: async () => [],
  })
  for (const entry of manifests) {
    registry.register(entry, { enabled: !disabled.includes(entry.id) })
  }
  return registry
}

function thread(): ChatThread {
  return {
    id: 'th1',
    title: 'Thread',
    messages: [],
    config: defaultThreadConfig('p1', 'm1'),
    createdAt: 1,
    updatedAt: 1,
  }
}

function context(session: Partial<AppSession> = {}): SlashContext {
  return {
    session: session as AppSession,
    threadId: 'th1',
    thread: thread(),
  }
}

describe('parseSlashInput', () => {
  it.each([
    ['plain text', 'hello there', { isSlash: false, name: '', args: '' }],
    ['a bare slash', '/', { isSlash: true, name: '', args: '' }],
    ['a command', '/compact', { isSlash: true, name: 'compact', args: '' }],
    [
      'a command with arguments',
      '/compact keep the API notes',
      { isSlash: true, name: 'compact', args: 'keep the API notes' },
    ],
    ['a skill', '/my-skill', { isSlash: true, name: 'my-skill', args: '' }],
    [
      'a source-suffixed skill with arguments',
      '/my-skill@workspace do the thing',
      { isSlash: true, name: 'my-skill@workspace', args: 'do the thing' },
    ],
    [
      'leading whitespace',
      '   /compact  trim me  ',
      { isSlash: true, name: 'compact', args: 'trim me' },
    ],
    ['a mid-text slash', 'use /compact later', { isSlash: false, name: '', args: '' }],
  ])('handles %s', (_label, input, expected) => {
    expect(parseSlashInput(input)).toEqual(expected)
  })
})

describe('slashEntries', () => {
  it('lists the built-in commands first, then the enabled skills', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('alpha', 'vault'), manifest('beta', 'vault')]),
    )
    expect(entries.map((entry) => entry.id)).toEqual(['compact', 'alpha', 'beta'])
    expect(entries[0].kind).toBe('command')
    expect(entries[1].kind).toBe('skill')
  })

  it('omits a skill that is not globally enabled', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('alpha', 'vault'), manifest('hidden', 'vault')], ['hidden']),
    )
    expect(entries.map((entry) => entry.id)).not.toContain('hidden')
    expect(resolveSlash(entries, 'hidden')).toBeUndefined()
  })

  it('tags the workspace source, so an untrusted skill is visible as one', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('alpha', 'workspace')]),
    )
    expect(entries[1].source).toBe('workspace')
  })

  it('suffixes only the workspace half of a duplicated id', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('dual', 'vault'), manifest('dual', 'workspace')]),
    )
    expect(entries.map((entry) => entry.id)).toEqual([
      'compact',
      'dual',
      'dual@workspace',
    ])
  })

  it('lets a built-in command win a name collision with a skill', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('compact', 'workspace')]),
    )
    expect(entries.filter((entry) => entry.id === 'compact')).toHaveLength(1)
    expect(resolveSlash(entries, 'compact')?.kind).toBe('command')
  })
})

describe('resolveSlash', () => {
  it('resolves a unique skill id without a suffix', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('only', 'workspace')]),
    )
    expect(resolveSlash(entries, 'only')?.source).toBe('workspace')
  })

  it('prefers the vault entry for a duplicated id', () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('dual', 'vault'), manifest('dual', 'workspace')]),
    )
    expect(resolveSlash(entries, 'dual')?.source).toBe('vault')
    expect(resolveSlash(entries, 'dual@workspace')?.source).toBe('workspace')
    expect(resolveSlash(entries, 'dual@vault')?.source).toBe('vault')
  })

  it('is undefined for an unknown name', () => {
    const entries = slashEntries(BUILTIN_SLASH_COMMANDS, registryWith([]))
    expect(resolveSlash(entries, 'nope')).toBeUndefined()
  })
})

describe('runSlashCommand', () => {
  it('runs a registered command with its trailing text as arguments', async () => {
    const seen: string[] = []
    const command: SlashCommand = {
      id: 'probe',
      label: '/probe',
      description: 'a test command',
      run: async (_ctx, args) => {
        seen.push(args)
      },
    }
    const entries = slashEntries([command], registryWith([]))

    await runSlashCommand(entries, context(), '/probe with arguments')

    expect(seen).toEqual(['with arguments'])
  })

  it('drives a newly registered command end to end with no other change', async () => {
    // This is the extensibility claim: a registry entry plus a handler is the
    // whole cost, with nothing added to the composer or the send path.
    let ran = false
    const command: SlashCommand = {
      id: 'brand-new',
      label: '/brand-new',
      description: 'added by a test',
      run: async () => {
        ran = true
      },
    }
    const entries = slashEntries([...BUILTIN_SLASH_COMMANDS, command], registryWith([]))

    await runSlashCommand(entries, context(), '/brand-new')

    expect(ran).toBe(true)
    expect(entries.map((entry) => entry.id)).toContain('brand-new')
  })

  it('reports the available entries for an unknown name and runs nothing', async () => {
    const entries = slashEntries(
      BUILTIN_SLASH_COMMANDS,
      registryWith([manifest('alpha', 'vault')]),
    )
    await expect(runSlashCommand(entries, context(), '/nope')).rejects.toThrow(
      /no command or skill called "\/nope".*\/compact, \/alpha/s,
    )
  })

  it('rejects a bare slash rather than sending it to the model', async () => {
    const entries = slashEntries(BUILTIN_SLASH_COMMANDS, registryWith([]))
    await expect(runSlashCommand(entries, context(), '/')).rejects.toThrow(
      /no command or skill/,
    )
  })
})

describe('/compact', () => {
  it('compacts through the engine and starts no model run', async () => {
    const calls: [string, string | undefined][] = []
    const session = {
      engineFor: () => ({
        compact: async (threadId: string, instructions?: string) => {
          calls.push([threadId, instructions])
        },
        sendTurn: async () => {
          throw new Error('/compact must not start a run')
        },
      }),
    } as unknown as AppSession
    const entries = slashEntries(BUILTIN_SLASH_COMMANDS, registryWith([]))

    await runSlashCommand(entries, context(session), '/compact keep the API notes')

    expect(calls).toEqual([['th1', 'keep the API notes']])
  })
})

describe('looksLikeSlashCommand', () => {
  it.each([
    ['/compact', true],
    ['/compact keep the notes', true],
    ['/my-skill@workspace do it', true],
    ['  /compact', true],
    ['/', false],
    ['/tmp/foo is missing', false],
    ['/usr/bin is on PATH', false],
    ['plain text', false],
    ['use /compact later', false],
  ])('reads %s as a command: %s', (text, expected) => {
    expect(looksLikeSlashCommand(text)).toBe(expected)
  })
})

describe('unknown command errors', () => {
  it('carries the unsent text, because the composer has already cleared it', async () => {
    const entries = slashEntries(BUILTIN_SLASH_COMMANDS, registryWith([]))
    await expect(
      runSlashCommand(entries, context(), '/compct hello there'),
    ).rejects.toThrow(/hello there/)
  })
})
