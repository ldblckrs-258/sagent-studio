import type { Resource } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { McpConnectionManager, emptyCatalog } from '../../mcp/manager'
import { MCP_RESOURCE_LIST_MAX, createMcpResourcePort } from '../../mcp/resource-port'
import { memoryPersistence, serverConfig } from '../../mcp/test-fixtures'
import type { McpResourcePort, ToolRuntimePorts } from '../types'
import { MCP_RESOURCE_TEXT_MAX, createMcpResourceToolProvider } from './mcp-resources'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

async function readyManager(
  resources: Resource[] = [{ uri: 'file:///readme.md', name: 'readme', mimeType: 'text/markdown' }],
) {
  const manager = new McpConnectionManager({
    persistence: memoryPersistence([serverConfig({ name: 'Docs', enabled: false })]),
  })
  await manager.hydrate()
  manager.store.setState((state) => ({
    servers: {
      ...state.servers,
      mcp_one: {
        ...state.servers.mcp_one!,
        state: 'ready',
        catalog: {
          ...emptyCatalog(),
          resources,
          resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
        },
      },
    },
  }))
  return manager
}

async function call(port: McpResourcePort, name: string, input: unknown) {
  const tool = createMcpResourceToolProvider().create(name, { mcp: port } as ToolRuntimePorts)
  return tool.execute!(input as never, CALL)
}

describe('MCP resource port', () => {
  it('lists only ready servers that offer resources, capped per server', async () => {
    const many = Array.from({ length: MCP_RESOURCE_LIST_MAX + 5 }, (_, index) => ({
      uri: `file:///${index}`,
      name: `r${index}`,
    }))
    const manager = await readyManager(many)
    const [server] = createMcpResourcePort(manager).servers()
    expect(server?.name).toBe('Docs')
    expect(server?.resources).toHaveLength(MCP_RESOURCE_LIST_MAX)
    expect(server?.truncated).toBe(true)
    await manager.dispose()
    expect(createMcpResourcePort(manager).servers()).toEqual([])
  })

  it('describes blob contents by size without passing the bytes on', async () => {
    const manager = await readyManager()
    vi.spyOn(manager, 'readResource').mockResolvedValue({
      contents: [
        { uri: 'file:///a', text: 'hello', mimeType: 'text/plain' },
        { uri: 'file:///b', blob: 'AAAAAA==', mimeType: 'application/octet-stream' },
      ],
    })
    expect(await createMcpResourcePort(manager).read('mcp_one', 'file:///a')).toEqual([
      { uri: 'file:///a', mimeType: 'text/plain', text: 'hello' },
      { uri: 'file:///b', mimeType: 'application/octet-stream', bytes: 4 },
    ])
    await manager.dispose()
  })
})

describe('MCP resource tools', () => {
  it('are only offered while a ready server has resources', async () => {
    const provider = createMcpResourceToolProvider()
    expect(provider.isAvailable({})).toBe(false)
    const manager = await readyManager()
    expect(provider.isAvailable({ mcp: createMcpResourcePort(manager) })).toBe(true)
    await manager.dispose()
    expect(provider.isAvailable({ mcp: createMcpResourcePort(manager) })).toBe(false)
  })

  it('lists resources and templates by server name', async () => {
    const manager = await readyManager()
    const port = createMcpResourcePort(manager)
    expect(await call(port, 'list_mcp_resources', {})).toEqual({
      ok: true,
      code: 'ok',
      value: {
        servers: [
          {
            server: 'Docs',
            resources: [{ uri: 'file:///readme.md', name: 'readme', mimeType: 'text/markdown' }],
            templates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
            truncated: false,
          },
        ],
      },
    })
    expect(await call(port, 'list_mcp_resources', { server: 'docs' })).toMatchObject({ ok: true })
    expect(await call(port, 'list_mcp_resources', { server: 'nope' })).toMatchObject({
      ok: false,
      code: 'not_found',
      hint: 'Servers with resources: Docs.',
    })
    await manager.dispose()
  })

  it('reads a resource through the server and caps long text', async () => {
    const manager = await readyManager()
    const read = vi.spyOn(manager, 'readResource').mockResolvedValue({
      contents: [{ uri: 'file:///readme.md', text: 'x'.repeat(MCP_RESOURCE_TEXT_MAX + 1) }],
    })
    const result = (await call(createMcpResourcePort(manager), 'read_mcp_resource', {
      server: 'Docs',
      uri: 'file:///readme.md',
    })) as { ok: boolean; truncated?: boolean; value: { contents: Array<{ text: string }> } }
    expect(read).toHaveBeenCalledWith('mcp_one', 'file:///readme.md', undefined)
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.value.contents[0]?.text).toHaveLength(MCP_RESOURCE_TEXT_MAX)
    await manager.dispose()
  })

  it('rejects a call without both server and uri, and reports a server failure as a failed result', async () => {
    const manager = await readyManager()
    const port = createMcpResourcePort(manager)
    expect(await call(port, 'read_mcp_resource', { server: 'Docs' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    vi.spyOn(manager, 'readResource').mockRejectedValue(new Error('Resource not found'))
    expect(await call(port, 'read_mcp_resource', { server: 'Docs', uri: 'file:///x' })).toMatchObject({
      ok: false,
      message: 'Resource not found',
    })
    await manager.dispose()
  })
})
