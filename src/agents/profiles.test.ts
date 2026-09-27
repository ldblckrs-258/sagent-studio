import type { LanguageModel } from 'ai'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import { ToolRegistry } from '../tools/registry'
import type { ToolProvider, ToolRuntimePorts, WorkspaceApi, WorkspaceEntry } from '../tools/types'
import { defaultSettings } from '../vault/settings'
import { WorkspaceNotFoundError } from '../workspace/errors'
import { createWorkspaceProfileSource } from './profile-workspace-source'
import {
  AgentProfileParseError,
  AgentProfileRegistry,
  applyAgentProfile,
  BUILTIN_AGENT_PROFILES,
  parseAgentProfileMarkdown,
} from './profiles'
import { createAgentRuntime } from './runtime'
import { AgentRunStore } from './store'
import { resolveAgentToolNames } from './toolset'
import type { AgentParentContext } from './types'

const skillStore: SkillStore = { save: async () => {}, remove: async () => {}, list: async () => [] }
const TOOL_NAMES = ['read_file', 'write_file', 'search']

function provider(): ToolProvider {
  return {
    names: TOOL_NAMES,
    isAvailable: () => true,
    create: (name) =>
      tool({ description: name, inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ok' }),
  }
}

function parent(overrides: Partial<AgentParentContext> = {}): AgentParentContext {
  return {
    parentThreadId: 'parent-1',
    mode: 'editing',
    toolNames: ['read_file', 'write_file'],
    providerId: 'p1',
    modelId: 'm1',
    ...overrides,
  }
}

function fakeWorkspace(files: Record<string, string>): WorkspaceApi {
  return {
    list: async (path: string) => {
      const entries: WorkspaceEntry[] = Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => ({ name: file.slice(path.length + 1), path: file, kind: 'file' }))
      if (entries.length === 0) throw new WorkspaceNotFoundError(path)
      return entries
    },
    readFile: async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new WorkspaceNotFoundError(path)
      return text
    },
  } as unknown as WorkspaceApi
}

describe('parseAgentProfileMarkdown', () => {
  it('reads every frontmatter field and uses the body as instructions', () => {
    const profile = parseAgentProfileMarkdown(
      [
        '---',
        'name: Security reviewer',
        'description: Audits auth code',
        'mode: read_only',
        'tier: high',
        'tools: [read_file, search]',
        'exclude-tools: write_file',
        'skills: [owasp]',
        'inherit-instructions: true',
        '---',
        'Check every auth path.',
      ].join('\n'),
      'sec',
    )

    expect(profile).toEqual({
      id: 'sec',
      name: 'Security reviewer',
      description: 'Audits auth code',
      mode: 'read_only',
      tier: 'high',
      tools: ['read_file', 'search'],
      excludeTools: ['write_file'],
      skills: ['owasp'],
      inheritInstructions: true,
      instructions: 'Check every auth path.',
    })
  })

  it('names the field when a value is invalid, so the author can fix the file', () => {
    expect(() => parseAgentProfileMarkdown('---\nmode: admin\n---\nx', 'a')).toThrow(/"mode"/)
    expect(() => parseAgentProfileMarkdown('---\ntier: huge\n---\nx', 'a')).toThrow(/"tier"/)
    expect(() => parseAgentProfileMarkdown('---\ntools: 3\n---\nx', 'a')).toThrow(/"tools"/)
    expect(() => parseAgentProfileMarkdown('---\ninherit-instructions: yes please\n---\nx', 'a')).toThrow(
      AgentProfileParseError,
    )
  })
})

describe('AgentProfileRegistry', () => {
  it('lets a workspace file override a built-in id and reports a broken file without dropping the rest', async () => {
    const registry = new AgentProfileRegistry()
    await registry.load(
      createWorkspaceProfileSource(
        fakeWorkspace({
          '.agents/agents/reviewer.md': '---\ndescription: House reviewer\n---\nUse our checklist.',
          '.agents/agents/broken.md': '---\nmode: admin\n---\nx',
          '.agents/agents/docs.md': '---\ndescription: Writes docs\n---\nWrite docs.',
          '.agents/agents/notes.txt': 'ignored',
        }),
      ),
    )

    const reviewer = registry.get('reviewer')
    expect(reviewer?.source).toBe('workspace')
    expect(reviewer?.instructions).toBe('Use our checklist.')
    expect(registry.get('docs')?.description).toBe('Writes docs')
    expect(registry.get('broken')).toBeUndefined()
    expect(registry.get('explorer')?.source).toBe('builtin')
    expect(registry.loadErrors()).toEqual([
      { path: '.agents/agents/broken.md', message: expect.stringContaining('"mode"') },
    ])
  })

  it('makes an earlier caller wait for the newest load instead of reading a stale list', async () => {
    const registry = new AgentProfileRegistry()
    let releaseFirst!: () => void
    const slow = {
      list: () =>
        new Promise<{ profiles: never[]; errors: never[] }>((resolve) => {
          releaseFirst = () => resolve({ profiles: [], errors: [] })
        }),
    }
    let releaseSecond!: () => void
    const fresh = createWorkspaceProfileSource(
      fakeWorkspace({ '.agents/agents/docs.md': '---\ndescription: Writes docs\n---\nWrite docs.' }),
    )
    const gated = {
      list: async () => {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve
        })
        return fresh.list()
      },
    }

    const first = registry.load(slow)
    const second = registry.load(gated)
    let firstDone = false
    void first.then(() => {
      firstDone = true
    })
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(firstDone).toBe(false)
    releaseSecond()
    await first
    expect(registry.get('docs')?.description).toBe('Writes docs')
    await second
  })

  it('falls back to the built-ins when the workspace has no profile folder', async () => {
    const registry = new AgentProfileRegistry()
    await registry.load(createWorkspaceProfileSource(fakeWorkspace({})))

    expect(registry.list().map((profile) => profile.id)).toEqual(
      BUILTIN_AGENT_PROFILES.map((profile) => profile.id).sort(),
    )
    expect(registry.loadErrors()).toEqual([])
  })
})

describe('applyAgentProfile', () => {
  const reviewer = BUILTIN_AGENT_PROFILES.find((profile) => profile.id === 'reviewer')

  it('takes the profile mode and tier as defaults', () => {
    const request = applyAgentProfile({ prompt: 'review', agent: 'reviewer' }, reviewer)
    expect(request).toMatchObject({ mode: 'read_only', tier: 'high', agent: 'reviewer' })
  })

  it('lets an explicit field override the profile', () => {
    const request = applyAgentProfile({ prompt: 'review', agent: 'reviewer', tier: 'cheap' }, reviewer)
    expect(request.tier).toBe('cheap')
  })

  it('merges profile and requested skills and exclusions', () => {
    const request = applyAgentProfile(
      { prompt: 'x', skills: ['b'], excludeTools: ['search'] },
      { ...BUILTIN_AGENT_PROFILES[0], skills: ['a'], excludeTools: ['write_file'] },
    )
    expect(request.skills).toEqual(['a', 'b'])
    expect(request.excludeTools).toEqual(['write_file', 'search'])
  })
})

describe('profile tool allowlist', () => {
  it('narrows to the parent pool and can never add a tool the parent lacks', () => {
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerProvider(provider())
    const resolved = resolveAgentToolNames({
      toolRegistry,
      skillRegistry: new SkillRegistry(skillStore),
      ports: {} as ToolRuntimePorts,
      parent: parent(),
      request: { prompt: 'x', mode: 'editing', tier: 'medium', allowTools: ['read_file', 'search'] },
    })

    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.names).toEqual(['read_file'])
  })
})

describe('runtime profile resolution', () => {
  function build(model: MockLanguageModelV4, registry: AgentProfileRegistry) {
    const store = new AgentRunStore()
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerProvider(provider())
    const runtime = createAgentRuntime({
      getSettings: () => defaultSettings(),
      skillRegistry: new SkillRegistry(skillStore),
      toolRegistry,
      store,
      profiles: { get: (id) => registry.get(id), list: () => registry.list() },
      modelFactory: () => model as unknown as LanguageModel,
      portsFor: () => ({}) as ToolRuntimePorts,
    })
    return { runtime, store }
  }

  function answering(): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doStream: [
        {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 't' })
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'ok' })
              controller.enqueue({ type: 'text-end', id: 't' })
              controller.enqueue({
                type: 'finish',
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
                finishReason: { unified: 'stop', raw: undefined },
              })
              controller.close()
            },
          }),
        },
      ],
    })
  }

  it('applies a profile, records it on the run, and keeps the mode under the parent ceiling', async () => {
    const model = answering()
    const { runtime, store } = build(model, new AgentProfileRegistry())

    const outcome = await runtime.spawn(parent({ mode: 'read_only' }), { prompt: 'fix it', agent: 'worker' })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.result.mode).toBe('read_only')
    expect(outcome.result.tier).toBe('medium')
    const record = store.get(outcome.runId)
    expect(record?.profile).toBe('worker')
    const system = model.doStreamCalls[0].prompt.find((message) => message.role === 'system')
    expect(system?.content).toContain('You implement one bounded change.')
  })

  it('refuses an unknown profile and lists the ones that exist', async () => {
    const model = answering()
    const { runtime, store } = build(model, new AgentProfileRegistry())

    const outcome = await runtime.spawn(parent(), { prompt: 'x', agent: 'wizard' })

    expect(outcome.status).toBe('invalid_input')
    if (outcome.status === 'invalid_input') {
      expect(outcome.message).toContain('wizard')
      expect(outcome.message).toContain('explorer, planner, reviewer, worker')
    }
    expect(store.list()).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('passes the parent instruction through only for a profile that inherits it', async () => {
    const registry = new AgentProfileRegistry()
    await registry.load(
      createWorkspaceProfileSource(
        fakeWorkspace({
          '.agents/agents/inheritor.md': '---\ninherit-instructions: true\n---\nFollow the house rules.',
        }),
      ),
    )
    const inheriting = answering()
    const plain = answering()

    await build(inheriting, registry).runtime.spawn(parent({ systemInstruction: 'Answer in French.' }), {
      prompt: 'x',
      agent: 'inheritor',
    })
    await build(plain, registry).runtime.spawn(parent({ systemInstruction: 'Answer in French.' }), {
      prompt: 'x',
      agent: 'explorer',
    })

    const systemOf = (model: MockLanguageModelV4) =>
      model.doStreamCalls[0].prompt.find((message) => message.role === 'system')?.content
    expect(systemOf(inheriting)).toContain('Answer in French.')
    expect(systemOf(plain)).not.toContain('Answer in French.')
  })
})
