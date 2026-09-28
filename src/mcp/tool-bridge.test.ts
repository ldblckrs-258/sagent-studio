import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import type { ToolResult } from '../tools/result'
import { McpConnectionManager, emptyCatalog } from './manager'
import type { McpServerView } from './manager'
import { memoryPersistence, serverConfig } from './test-fixtures'
import {
  MCP_DESCRIPTION_MAX,
  MCP_RESULT_TEXT_MAX,
  bindMcpTools,
  buildMcpToolEntries,
  mapCallToolResult,
  mcpToolName,
} from './tool-bridge'

function view(patch: Partial<McpServerView> = {}): McpServerView {
  return {
    config: serverConfig({ name: 'Linear' }),
    state: 'ready',
    catalog: {
      ...emptyCatalog(),
      tools: [
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } },
        { name: 'list-issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      ],
    },
    skippedTools: [],
    ...patch,
  }
}

describe('mcpToolName', () => {
  it('namespaces by server and keeps readable names', () => {
    expect(mcpToolName('Linear', 'create_issue')).toBe('mcp_linear_create_issue')
    expect(mcpToolName('My GitHub', 'Get-Item.v2')).toBe('mcp_my_github_get_item_v2')
    expect(mcpToolName('Linear', '工具')).toBe('mcp_linear_tool')
  })

  it('fits the 64-character limit with a stable hash so two long names do not merge', () => {
    const a = mcpToolName('Server', `${'very_long_tool_name_'.repeat(4)}alpha`)
    const b = mcpToolName('Server', `${'very_long_tool_name_'.repeat(4)}beta`)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^mcp_server_[a-z0-9_]+_[0-9a-f]{6}$/)
    expect(mcpToolName('Server', `${'very_long_tool_name_'.repeat(4)}alpha`)).toBe(a)
  })
})

describe('mapCallToolResult', () => {
  it('joins text and describes binary content without forwarding its bytes to the model', () => {
    const result = mapCallToolResult({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'file:///a.md', name: 'a' },
        { type: 'resource', resource: { uri: 'file:///b.md', text: 'bee' } },
        { type: 'resource', resource: { uri: 'file:///c.bin', blob: 'AAAAAA==', mimeType: 'application/octet-stream' } },
      ],
      structuredContent: { count: 2 },
    }) as ToolResult<{ text: string; content: unknown[]; structuredContent: unknown }>
    expect(result.ok).toBe(true)
    expect(result.value?.text).toBe('first\n\nResource file:///b.md:\nbee')
    expect(result.value?.content).toEqual([
      { type: 'image', mimeType: 'image/png', bytes: 5 },
      { type: 'audio', mimeType: 'audio/wav', bytes: 3 },
      { type: 'resource_link', uri: 'file:///a.md', name: 'a' },
      { type: 'resource', uri: 'file:///c.bin', mimeType: 'application/octet-stream', bytes: 4 },
    ])
    expect(result.value?.structuredContent).toEqual({ count: 2 })
    expect(JSON.stringify(result)).not.toContain('aGVsbG8=')
  })

  it('turns isError into a failed tool result the model can read', () => {
    expect(mapCallToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toEqual({
      ok: false,
      code: 'runtime_error',
      message: 'boom',
    })
    expect(mapCallToolResult({ content: [], isError: true })).toMatchObject({
      ok: false,
      message: 'The MCP tool reported an error without a message.',
    })
  })

  it('caps huge text and marks the result truncated', () => {
    const result = mapCallToolResult({ content: [{ type: 'text', text: 'x'.repeat(MCP_RESULT_TEXT_MAX + 10) }] }) as ToolResult<{ text: string }>
    expect(result.value?.text).toHaveLength(MCP_RESULT_TEXT_MAX)
    expect(result.truncated).toBe(true)
  })
})

describe('buildMcpToolEntries', () => {
  it('builds one gated-kind entry per enabled tool, labeled with the server', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }))
    const built = buildMcpToolEntries(view(), { callTool })
    expect(built.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['mcp_linear_create_issue', 'mcp'],
      ['mcp_linear_list_issues', 'mcp'],
    ])
    const created = built.entries[0]!.create({})
    expect(created.description).toBe('[MCP: Linear] Create an issue')
    const controller = new AbortController()
    const output = await created.execute!({ title: 't' }, { toolCallId: 'c', messages: [], context: {}, abortSignal: controller.signal })
    expect(callTool).toHaveBeenCalledWith('mcp_one', 'create_issue', { title: 't' }, controller.signal)
    expect(output).toEqual({ ok: true, code: 'ok', value: { text: 'done' } })
  })

  it('reports a server error as a failed tool result instead of throwing into the turn', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('The MCP server "Linear" is not connected.')
    })
    const created = buildMcpToolEntries(view(), { callTool }).entries[0]!.create({})
    expect(await created.execute!({}, { toolCallId: 'c', messages: [], context: {} })).toMatchObject({
      ok: false,
      message: 'The MCP server "Linear" is not connected.',
    })
  })

  it('skips disabled tools, unsafe schemas, and name collisions, with a reason for each', () => {
    const built = buildMcpToolEntries(
      view({
        config: serverConfig({ name: 'Linear', disabledTools: ['create_issue'] }),
        catalog: {
          ...emptyCatalog(),
          tools: [
            { name: 'create_issue', inputSchema: { type: 'object' } },
            { name: 'list_issues', inputSchema: { type: 'object' } },
            { name: 'list-issues', inputSchema: { type: 'object' } },
            { name: 'polluted', inputSchema: JSON.parse('{"type":"object","properties":{"__proto__":{}}}') },
          ],
        },
      }),
      { callTool: vi.fn() },
    )
    expect(built.entries.map((entry) => entry.name)).toEqual(['mcp_linear_list_issues'])
    expect(built.skipped.map((entry) => entry.name)).toEqual(['list-issues', 'polluted'])
    expect(built.skipped[0]?.reason).toMatch(/collides with the tool "list_issues"/)
  })

  it('caps a long description', () => {
    const built = buildMcpToolEntries(
      view({
        catalog: { ...emptyCatalog(), tools: [{ name: 'a', description: 'd'.repeat(5_000), inputSchema: { type: 'object' } }] },
      }),
      { callTool: vi.fn() },
    )
    expect(built.entries[0]!.create({}).description).toHaveLength(MCP_DESCRIPTION_MAX)
  })
})

describe('bindMcpTools', () => {
  it('publishes tools when a server is ready and withdraws them when it is not', async () => {
    const manager = new McpConnectionManager({ persistence: memoryPersistence([serverConfig({ name: 'Linear', enabled: false })]) })
    await manager.hydrate()
    const registry = new ToolRegistry()
    const unbind = bindMcpTools(manager, registry)
    expect(registry.availableNames({})).toEqual([])

    manager.store.setState((state) => ({
      servers: { ...state.servers, mcp_one: { ...view(), config: state.servers.mcp_one!.config } },
    }))
    expect(registry.availableNames({})).toEqual(['mcp_linear_create_issue', 'mcp_linear_list_issues'])

    manager.store.setState((state) => ({
      servers: { ...state.servers, mcp_one: { ...state.servers.mcp_one!, state: 'error' } },
    }))
    expect(registry.availableNames({})).toEqual([])

    unbind()
    await manager.dispose()
  })

  it('reports tools the registry refused so the panel can show why they are missing', async () => {
    const manager = new McpConnectionManager({ persistence: memoryPersistence([serverConfig({ name: 'Linear', enabled: false })]) })
    await manager.hydrate()
    const registry = new ToolRegistry()
    registry.registerUserTool({
      kind: 'http',
      name: 'mcp_linear_create_issue',
      description: 'squatter',
      inputSchema: { type: 'object' },
      request: { url: 'https://api.example.com', allowedOrigins: ['https://api.example.com'] },
      enabled: true,
    })
    const unbind = bindMcpTools(manager, registry)
    manager.store.setState((state) => ({
      servers: { ...state.servers, mcp_one: { ...view(), config: state.servers.mcp_one!.config } },
    }))
    expect(manager.view('mcp_one')?.skippedTools).toEqual([
      { name: 'create_issue', reason: 'A tool named "mcp_linear_create_issue" already exists.' },
    ])
    expect(registry.toolKind('mcp_linear_create_issue')).toBe('http')
    unbind()
    await manager.dispose()
  })

  it('clears a removed server and every source on unbind', async () => {
    const manager = new McpConnectionManager({ persistence: memoryPersistence([serverConfig({ name: 'Linear', enabled: false })]) })
    await manager.hydrate()
    const registry = new ToolRegistry()
    const unbind = bindMcpTools(manager, registry)
    manager.store.setState((state) => ({
      servers: { ...state.servers, mcp_one: { ...view(), config: state.servers.mcp_one!.config } },
    }))
    await manager.removeServer('mcp_one')
    expect(registry.availableNames({})).toEqual([])
    unbind()
    await manager.dispose()
  })
})

describe('payload caps', () => {
  it('skips a tool whose schema is too large to send every turn', () => {
    const huge = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(30_000) } } }
    const built = buildMcpToolEntries(
      view({ catalog: { ...emptyCatalog(), tools: [{ name: 'big', inputSchema: huge as never }] } }),
      { callTool: vi.fn() },
    )
    expect(built.entries).toEqual([])
    expect(built.skipped[0]?.reason).toMatch(/larger than/)
  })

  it('drops oversized structured content and extra content items, and says so', () => {
    const result = mapCallToolResult({
      content: Array.from({ length: 60 }, () => ({ type: 'image' as const, data: 'AA==', mimeType: 'image/png' })),
      structuredContent: { blob: 'y'.repeat(120_000) },
    }) as ToolResult<{ content: unknown[]; structuredContent?: unknown }>
    expect(result.value?.content).toHaveLength(50)
    expect(result.value?.structuredContent).toBeUndefined()
    expect(result.truncated).toBe(true)
  })
})
