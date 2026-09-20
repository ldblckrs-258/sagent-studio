import { beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillManifest } from '../skills/schema'
import type { AppSession } from '../session/session'
import { createSkillLoadPort } from './engine'
import { invokeSkill, skillDirectiveMessage } from './skill-invoke'
import type { SlashContext } from './slash'
import { useChatStore } from './store'
import type { ChatMessageMetadata } from './sanitize'
import type { ChatThread, SkillRef } from './types'
import { defaultThreadConfig } from './types'

function manifest(id: string, source: 'vault' | 'workspace', name = id): SkillManifest {
  return {
    id,
    name,
    description: `${id} does a thing`,
    instructions: 'INSTRUCTIONS_BODY',
    allowedTools: [],
    source,
  }
}

function registryWith(manifests: readonly SkillManifest[]): SkillRegistry {
  const registry = new SkillRegistry({
    save: async () => {},
    remove: async () => {},
    list: async () => [],
  })
  for (const entry of manifests) registry.register(entry, { enabled: true })
  return registry
}

function seed(config = defaultThreadConfig('p1', 'm1')): ChatThread {
  const thread: ChatThread = {
    id: 'th1',
    title: 'Thread',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    config,
    createdAt: 1,
    updatedAt: 1,
  }
  useChatStore.getState().setThread(thread)
  useChatStore.getState().setActiveThread('th1')
  return thread
}

function harness(registry: SkillRegistry) {
  const saved: ChatThread[] = []
  const turns: string[] = []
  const session = {
    skillRegistry: registry,
    threadStore: {
      saveThread: async (thread: ChatThread) => {
        saved.push(thread)
      },
    },
    engineFor: () => ({
      sendTurn: async (_id: string, text: string) => {
        turns.push(text)
      },
    }),
  } as unknown as AppSession
  const ctx: SlashContext = {
    session,
    threadId: 'th1',
    thread: useChatStore.getState().threads.th1,
  }
  return { ctx, saved, turns }
}

function directiveOf(thread: ChatThread) {
  const last = thread.messages[thread.messages.length - 1]
  return {
    message: last,
    meta: (last.metadata as ChatMessageMetadata | undefined)?.skillDirective,
  }
}

beforeEach(() => {
  useChatStore.getState().clear()
})

describe('skillDirectiveMessage', () => {
  it('names the tool and the target and carries the marker metadata', () => {
    const message = skillDirectiveMessage({
      id: 'alpha',
      source: 'vault',
      name: 'Alpha',
    })
    const text = message.parts
      .map((part) => (part as { text?: string }).text ?? '')
      .join('')
    expect(text).toContain('load_skill')
    expect(text).toContain('alpha')
    expect(text).toContain('vault')
    expect((message.metadata as ChatMessageMetadata).skillDirective).toEqual({
      id: 'alpha',
      source: 'vault',
      name: 'Alpha',
    })
  })

  it('stays short, so invoking a skill costs far less than its body', () => {
    const message = skillDirectiveMessage({ id: 'alpha', source: 'vault', name: 'Alpha' })
    const text = message.parts
      .map((part) => (part as { text?: string }).text ?? '')
      .join('')
    expect(text.split('\n')).toHaveLength(1)
    expect(text.length).toBeLessThan(200)
    expect(text).not.toContain('INSTRUCTIONS_BODY')
  })
})

describe('invokeSkill', () => {
  it('enables the skill on the thread and persists it', async () => {
    const registry = registryWith([manifest('alpha', 'vault')])
    seed()
    const { ctx, saved } = harness(registry)

    await invokeSkill(ctx, { id: 'alpha', source: 'vault' }, '')

    const stored = useChatStore.getState().threads.th1
    expect(stored.config.enabledSkills).toEqual([{ id: 'alpha', source: 'vault' }])
    expect(saved).toHaveLength(1)
    expect(saved[0].config.enabledSkills).toHaveLength(1)
  })

  it('never duplicates a ref the thread already has', async () => {
    const registry = registryWith([manifest('alpha', 'vault')])
    const ref: SkillRef = { id: 'alpha', source: 'vault' }
    seed({ ...defaultThreadConfig('p1', 'm1'), enabledSkills: [ref] })
    const { ctx } = harness(registry)

    await invokeSkill(ctx, ref, '')

    expect(useChatStore.getState().threads.th1.config.enabledSkills).toEqual([ref])
  })

  it('keeps the same id from another source as its own entry', async () => {
    const registry = registryWith([manifest('dual', 'vault'), manifest('dual', 'workspace')])
    seed({
      ...defaultThreadConfig('p1', 'm1'),
      enabledSkills: [{ id: 'dual', source: 'vault' }],
    })
    const { ctx } = harness(registry)

    await invokeSkill(ctx, { id: 'dual', source: 'workspace' }, '')

    expect(useChatStore.getState().threads.th1.config.enabledSkills).toEqual([
      { id: 'dual', source: 'vault' },
      { id: 'dual', source: 'workspace' },
    ])
  })

  it('appends only the directive and starts no run without trailing text', async () => {
    const registry = registryWith([manifest('alpha', 'vault', 'Alpha')])
    seed()
    const { ctx, turns } = harness(registry)

    await invokeSkill(ctx, { id: 'alpha', source: 'vault' }, '   ')

    const stored = useChatStore.getState().threads.th1
    expect(stored.messages).toHaveLength(2)
    expect(directiveOf(stored).meta?.name).toBe('Alpha')
    expect(turns).toEqual([])
  })

  it('appends the directive, then the text, and starts exactly one run', async () => {
    const registry = registryWith([manifest('alpha', 'vault')])
    seed()
    const { ctx, turns } = harness(registry)

    await invokeSkill(ctx, { id: 'alpha', source: 'vault' }, 'do the thing')

    const stored = useChatStore.getState().threads.th1
    // The directive is durable before the run begins, so the model sees it
    // ahead of the request it is meant to govern.
    expect(directiveOf(stored).meta?.id).toBe('alpha')
    expect(turns).toEqual(['do the thing'])
  })

  it('refuses a skill that is not installed', async () => {
    const registry = registryWith([])
    seed()
    const { ctx } = harness(registry)

    await expect(
      invokeSkill(ctx, { id: 'ghost', source: 'vault' }, ''),
    ).rejects.toThrow(/No skill "ghost"/)
  })

  it('leaves the run’s skill port able to resolve the invoked id', async () => {
    const registry = registryWith([manifest('alpha', 'vault')])
    seed()
    const { ctx } = harness(registry)

    await invokeSkill(ctx, { id: 'alpha', source: 'vault' }, '')

    // This is the pairing the directive depends on: `buildRunStream` builds the
    // port from `config.enabledSkills`, so without the enablement above the
    // tool call would resolve to null.
    const config = useChatStore.getState().threads.th1.config
    const port = createSkillLoadPort(registry.resolve(config.enabledSkills))
    expect(port.load('alpha', 'vault')?.instructions).toBe('INSTRUCTIONS_BODY')
    expect(port.list().map((skill) => skill.id)).toEqual(['alpha'])
  })
})
