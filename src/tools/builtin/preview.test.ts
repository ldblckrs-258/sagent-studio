import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolSet } from 'ai'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { PreviewPort, ToolRuntimePorts, WorkspaceApi } from '../types'
import { WorkspaceNotFoundError } from '../../workspace/errors'
import { createPreviewToolProvider } from './preview'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function workspaceWith(stat: WorkspaceApi['stat']): WorkspaceApi {
  return {
    list: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
    makeDir: async () => {},
    remove: async () => {},
    stat,
    move: async () => ({ from: '', to: '', kind: 'file', size: 0 }),
    copy: async () => ({ from: '', to: '', kind: 'file', size: 0 }),
    search: async () => ({ hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 }),
  }
}

function build(ports: ToolRuntimePorts): ToolSet {
  const registry = new ToolRegistry()
  registry.registerProvider(createPreviewToolProvider())
  return registry.buildToolSet(undefined, ports)
}

describe('createPreviewToolProvider', () => {
  it('contributes exactly open_preview', () => {
    const provider = createPreviewToolProvider()
    expect(provider.names).toEqual(['open_preview'])
    const workspace = workspaceWith(async (path) => ({ path, kind: 'file', size: 3 }))
    expect(Object.keys(build({ workspace, preview: { open: () => {} } }))).toEqual(['open_preview'])
  })

  it('is unavailable without a workspace or without a preview port', () => {
    const provider = createPreviewToolProvider()
    const workspace = workspaceWith(async (path) => ({ path, kind: 'file', size: 3 }))
    const preview: PreviewPort = { open: () => {} }
    expect(provider.isAvailable({})).toBe(false)
    expect(provider.isAvailable({ preview })).toBe(false)
    expect(provider.isAvailable({ workspace })).toBe(false)
    expect(provider.isAvailable({ workspace, preview })).toBe(true)
    expect(Object.keys(build({ workspace }))).toEqual([])
  })

  it('throws ToolRuntimeUnavailableError when built without a workspace', async () => {
    const provider = createPreviewToolProvider()
    const built = provider.create('open_preview', {}) as Tool
    const execute = built.execute
    if (!execute) throw new Error('missing execute')
    await expect(
      (execute as (input: unknown, options: typeof CALL) => Promise<unknown>)(
        { path: 'a.html' },
        CALL,
      ),
    ).rejects.toBeInstanceOf(ToolRuntimeUnavailableError)
  })

  it('opens a file and records the resolved path', async () => {
    const open = vi.fn()
    const workspace = workspaceWith(async (path) => ({ path, kind: 'file', size: 10 }))
    const set = build({ workspace, preview: { open } })
    await expect(executor(set, 'open_preview')({ path: 'artifacts/report.html' }, CALL)).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: { path: 'artifacts/report.html', opened: true },
    })
    expect(open).toHaveBeenCalledWith('artifacts/report.html')
  })

  it('rejects a directory with invalid_input and does not change the target', async () => {
    const open = vi.fn()
    const workspace = workspaceWith(async (path) => ({ path, kind: 'directory', size: 0 }))
    const set = build({ workspace, preview: { open } })
    await expect(executor(set, 'open_preview')({ path: 'artifacts' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('maps a missing path to not_found and does not change the target', async () => {
    const open = vi.fn()
    const workspace = workspaceWith(async (path) => {
      throw new WorkspaceNotFoundError(path)
    })
    const set = build({ workspace, preview: { open } })
    await expect(executor(set, 'open_preview')({ path: 'nope.html' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(open).not.toHaveBeenCalled()
  })
})
