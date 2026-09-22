import { beforeEach, describe, expect, it } from 'vitest'
import { abortersCount, useChatStore } from '../chat/store'
import { defaultThreadConfig } from '../chat/types'
import { db } from '../vault/db'
import { threadHandleId } from '../workspace/handle'
import { useWorkspaceStore } from './workspace-state'
import type { CodeRunner } from '../sandbox/types'
import { isGatedTool } from '../tools/approval'
import type { CodeToolRunners } from '../tools/builtin/code'
import { createSession } from './session'

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
    expect(abortersCount()).toBe(before + 2)

    session.disposeThread('t1')
    expect(abortersCount()).toBe(before + 1)

    session.dispose()
    expect(abortersCount()).toBe(before)
  })

  it('registers the builtin providers and hydrates idempotently', async () => {
    const session = createSession()
    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
    ])

    await session.toolRegistry.hydrate()
    await session.toolRegistry.hydrate()
    expect(session.toolRegistry.availableNames({})).toEqual([
      'change_mode',
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
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
      'read_tool_guide',
      'reset_sandbox',
      'run_js',
      'run_python',
    ])
    enabled = false
    expect(session.toolRegistry.availableNames({})).toEqual(['change_mode', 'read_tool_guide'])

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
