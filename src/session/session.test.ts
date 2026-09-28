import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '../agents/runtime'
import type { AgentRunRecord } from '../agents/store'
import type { AgentParentContext } from '../agents/types'
import { abortersCount, useChatStore } from '../chat/store'
import { defaultThreadConfig } from '../chat/types'
import { db } from '../vault/db'
import { threadHandleId } from '../workspace/handle'
import { useWorkspaceStore } from './workspace-state'
import type { CodeRunner } from '../sandbox/types'
import { isGatedTool } from '../tools/approval'
import type { CodeToolRunners } from '../tools/builtin/code'
import { agentNoticeFor, createAgentPorts, createSession } from './session'
import * as engineModule from '../chat/engine'
import type { EngineDeps } from '../chat/engine'
import { useMemoryStore } from '../memory/state'
import { fakeFolder, seededMemory } from '../memory/test-fixtures'
import type { WorkspaceFs } from '../workspace/fs'

vi.mock('../chat/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/engine')>()
  return { ...actual, createEngine: vi.fn(actual.createEngine) }
})

function noopRunner(): CodeRunner {
  return { run: async () => ({ stdout: '', stderr: '', result: null }) }
}

/**
 * The folder binding is fired and forgotten by the chat-store subscription and
 * reads IndexedDB, so it settles on a real task, not a microtask.
 */
async function expectFolder(name: string | null): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (useWorkspaceStore.getState().folderName === name) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(useWorkspaceStore.getState().folderName).toBe(name)
}

describe('createSession', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('follows the open conversation to the folder bound to it', async () => {
    const folder = (name: string) =>
      ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle
    await db.fs.put({ id: threadHandleId('t-a'), handle: folder('folder-a'), updatedAt: 1 })
    await db.fs.put({ id: threadHandleId('t-b'), handle: folder('folder-b'), updatedAt: 1 })
    const session = createSession()

    useChatStore.getState().setActiveThread('t-a')
    await expectFolder('folder-a')

    useChatStore.getState().setActiveThread('t-b')
    await expectFolder('folder-b')

    useChatStore.getState().setActiveThread('t-a')
    await expectFolder('folder-a')

    session.dispose()
    await useWorkspaceStore.getState().clear()
    await db.fs.delete(threadHandleId('t-a'))
    await db.fs.delete(threadHandleId('t-b'))
  })

  it('stops following conversations once disposed', async () => {
    await db.fs.put({
      id: threadHandleId('t-a'),
      handle: { name: 'folder-a', kind: 'directory' } as unknown as FileSystemDirectoryHandle,
      updatedAt: 1,
    })
    const session = createSession()
    session.dispose()

    useChatStore.getState().setActiveThread('t-a')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useWorkspaceStore.getState().folderName).toBeNull()

    await db.fs.delete(threadHandleId('t-a'))
  })

  it('memoizes one engine per thread and disposes it', () => {
    const before = abortersCount()
    const session = createSession()
    const first = session.engineFor('t1')

    expect(session.engineFor('t1')).toBe(first)
    expect(session.engineFor('t2')).not.toBe(first)
    // Two engines plus the session-scoped agent runtime's global abort.
    expect(abortersCount()).toBe(before + 3)

    session.disposeThread('t1')
    expect(abortersCount()).toBe(before + 2)

    session.dispose()
    expect(abortersCount()).toBe(before)
  })

  it('registers the builtin providers and hydrates idempotently', async () => {
    const session = createSession()
    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'message_agent',
      'read_agent',
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
      'spawn_agent',
      'stop_agent',
      'wait_agents',
    ])

    await session.toolRegistry.hydrate()
    await session.toolRegistry.hydrate()
    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'message_agent',
      'read_agent',
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
      'spawn_agent',
      'stop_agent',
      'wait_agents',
    ])

    session.dispose()
  })

  it('drops the code tools from the pool when the runner source is disabled', () => {
    let enabled = true
    const runners: CodeToolRunners = { js: noopRunner(), python: noopRunner() }
    const session = createSession({
      runnerSource: { getRunners: () => runners, isEnabled: () => enabled },
    })

    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'message_agent',
      'read_agent',
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
      'spawn_agent',
      'stop_agent',
      'wait_agents',
    ])
    enabled = false
    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'message_agent',
      'read_agent',
      'read_tool_guide',
      'spawn_agent',
      'stop_agent',
      'wait_agents',
    ])

    session.dispose()
  })

  it('reports load_skill availability from the thread config', () => {
    const session = createSession()
    session.skillRegistry.resolve = ((refs: readonly unknown[]) =>
      refs.length > 0
        ? [
            {
              id: 's1',
              name: 'S1',
              description: 'D1',
              instructions: 'body',
              source: 'vault' as const,
              allowedTools: [],
            },
          ]
        : []) as typeof session.skillRegistry.resolve

    expect(
      session.builtinProviders().find((entry) => entry.name === 'load_skill')?.available,
    ).toBe(false)

    const config = {
      ...defaultThreadConfig('p1', 'm1'),
      enabledSkills: [{ id: 's1', source: 'vault' as const }],
    }
    expect(
      session.builtinProviders(config).find((entry) => entry.name === 'load_skill')?.available,
    ).toBe(true)

    session.dispose()
  })

  it('exposes builtin tool details for the tools panel', () => {
    const session = createSession()
    const runJs = session.builtinProviders().find((entry) => entry.name === 'run_js')

    expect(runJs?.description).toMatch(/isolated worker/)
    expect(runJs?.inputSchema?.properties).toMatchObject({ source: { type: 'string' } })
    expect(runJs?.inputSchema?.required).toEqual(['source'])

    session.dispose()
  })

  it('lists the harness-management tools and gates only the mutations', () => {
    const session = createSession()
    const listed = session.builtinProviders(defaultThreadConfig('p1', 'm1'))
    const management = [
      'list_skills',
      'create_skill',
      'update_skill',
      'delete_skill',
      'list_user_tools',
      'create_tool',
      'update_tool',
      'delete_tool',
    ]
    for (const name of management) {
      expect(listed.find((entry) => entry.name === name)?.available, name).toBe(true)
    }

    const gated = listed
      .map((entry) => ({ name: entry.name, kind: 'builtin' as const }))
      .filter((tool) => isGatedTool(tool))
      .map((tool) => tool.name)
    for (const name of [
      'create_skill',
      'update_skill',
      'delete_skill',
      'create_tool',
      'update_tool',
      'delete_tool',
    ]) {
      expect(gated, name).toContain(name)
    }
    expect(gated).not.toContain('list_skills')
    expect(gated).not.toContain('list_user_tools')

    session.dispose()
  })

  it('reports update_plan availability from the thread config', () => {
    const session = createSession()
    expect(
      session.builtinProviders().find((entry) => entry.name === 'update_plan')?.available,
    ).toBe(false)
    expect(
      session
        .builtinProviders(defaultThreadConfig('p1', 'm1'))
        .find((entry) => entry.name === 'update_plan')?.available,
    ).toBe(true)
    session.dispose()
  })

  it('lists the open_preview tool from the preview provider', () => {
    const session = createSession()
    const listed = session.builtinProviders(defaultThreadConfig('p1', 'm1'))
    expect(listed.some((entry) => entry.name === 'open_preview')).toBe(true)
    session.dispose()
  })

  it('binds the agent control port to the calling parent thread', async () => {
    const runtime = {
      spawn: vi.fn(async () => ({ status: 'running', runId: 'run-1' })),
      steer: vi.fn(() => true),
      stop: vi.fn(() => true),
      read: vi.fn(async () => null),
      resolveRun: vi.fn(async () => null),
    } as unknown as AgentRuntime
    const context: AgentParentContext = {
      parentThreadId: 't1',
      mode: 'editing',
      toolNames: [],
      providerId: 'p1',
    }
    const port = createAgentPorts(runtime, context)

    await port.spawn({ prompt: 'go', mode: 'editing', tier: 'cheap' })
    expect(runtime.spawn).toHaveBeenCalledWith(
      context,
      { prompt: 'go', mode: 'editing', tier: 'cheap' },
      undefined,
    )

    port.steer?.('run-1', 'hi')
    expect(runtime.steer).toHaveBeenCalledWith('t1', 'run-1', 'hi')
    port.stop?.('run-1')
    expect(runtime.stop).toHaveBeenCalledWith('t1', 'run-1', undefined)
    await port.read?.('run-1', { lastN: 2 })
    expect(runtime.read).toHaveBeenCalledWith('t1', 'run-1', { lastN: 2 })
    await port.resolveRun?.({ label: 'scout' })
    expect(runtime.resolveRun).toHaveBeenCalledWith('t1', { label: 'scout' })
  })

  it('refuses to steer or stop a run that is not live', () => {
    const session = createSession()
    expect(session.steerAgentRun('missing', 'hi')).toBe(false)
    expect(session.stopAgentRun('missing')).toBe(false)
    session.dispose()
  })

  it('names the user stop in a settled run notice', () => {
    const record: AgentRunRecord = {
      runId: 'run-1',
      parentThreadId: 't1',
      label: 'scout',
      mode: 'editing',
      tier: 'cheap',
      status: 'stopped',
      prompt: 'go',
      messages: [],
      text: '',
      toolCalls: 0,
      approvals: [],
      startedAt: 1,
      stopReason: 'user_stop',
      result: {
        status: 'stopped',
        mode: 'editing',
        tier: 'cheap',
        text: '',
        toolCalls: 0,
        stopReason: 'user_stop',
      },
    }

    const notice = agentNoticeFor(record)
    expect(notice.text).toContain('stopped by the user')
    expect(notice.report).toMatchObject({
      status: 'stopped',
      label: 'scout',
      stopReason: 'user_stop',
    })
  })

  it('puts a structured result in the notice report and in the model-visible text', () => {
    const record: AgentRunRecord = {
      runId: 'run-2',
      parentThreadId: 't1',
      label: 'counter',
      mode: 'read_only',
      tier: 'cheap',
      status: 'completed',
      prompt: 'count',
      messages: [],
      text: 'three',
      toolCalls: 0,
      approvals: [],
      startedAt: 1,
      result: {
        status: 'completed',
        mode: 'read_only',
        tier: 'cheap',
        text: 'three',
        toolCalls: 0,
        structured: { count: 3 },
      },
    }

    const notice = agentNoticeFor(record)
    const partial = agentNoticeFor({
      ...record,
      result: { ...record.result!, filesChanged: ['a.ts'], filesChangedIncomplete: true },
    })
    expect(partial.text).toContain('may be incomplete')
    expect(partial.report.filesChangedIncomplete).toBe(true)
    expect(notice.report.structured).toEqual({ count: 3 })
    expect(notice.text).toContain('```json')
    expect(notice.text).toContain('"count": 3')
  })

  it('lists the five RAG tools without a vault-locked crash', () => {
    const session = createSession()
    const listed = session.builtinProviders(defaultThreadConfig('p1', 'm1')).map((entry) => entry.name)
    for (const name of [
      'list_documents',
      'search_documents',
      'get_chunk',
      'get_neighbors',
      'verify_citation',
    ]) {
      expect(listed).toContain(name)
    }
    session.dispose()
  })
})

describe('session memory wiring', () => {
  function engineDeps(session: ReturnType<typeof createSession>): EngineDeps {
    const createEngine = vi.mocked(engineModule.createEngine)
    createEngine.mockClear()
    session.engineFor('t-memory')
    const deps = createEngine.mock.calls[0]?.[0]
    if (!deps) throw new Error('engine was not created')
    return deps
  }

  function memoryToolAvailability(session: ReturnType<typeof createSession>): boolean[] {
    return session
      .builtinProviders()
      .filter((entry) => ['remember', 'update_memory', 'forget', 'recall_memory'].includes(entry.name))
      .map((entry) => entry.available)
  }

  it('offers no memory port or tools until the memory store is ready', async () => {
    useMemoryStore.getState().clear()
    const session = createSession()

    await expect(engineDeps(session).memory?.('t-memory')).resolves.toBeUndefined()
    expect(memoryToolAvailability(session)).toEqual([false, false, false, false])
    session.dispose()
  })

  it('scopes each turn to the folder open in the conversation', async () => {
    useMemoryStore.setState({
      status: 'ready',
      memories: [
        seededMemory({ id: 'mem_global' }),
        seededMemory({ id: 'mem_a', scope: { kind: 'workspace', scopeId: 's-a', label: 'project' } }),
        seededMemory({ id: 'mem_b', scope: { kind: 'workspace', scopeId: 's-b', label: 'project' } }),
      ],
      scopes: {
        's-a': { handle: fakeFolder('project', 'disk/a'), label: 'project' },
        's-b': { handle: fakeFolder('project', 'disk/b'), label: 'project' },
      },
    })
    useWorkspaceStore.getState().setFs({ handle: fakeFolder('project', 'disk/a') } as unknown as WorkspaceFs)
    const session = createSession()

    const port = await engineDeps(session).memory?.('t-memory')

    expect(port?.visible().map((memory) => memory.id).sort()).toEqual(['mem_a', 'mem_global'])
    expect(memoryToolAvailability(session)).toEqual([true, true, true, true])
    session.dispose()
    useMemoryStore.getState().clear()
    await useWorkspaceStore.getState().clear()
  })
})
