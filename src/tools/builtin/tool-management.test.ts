import { describe, expect, it } from 'vitest'
import type {
  HttpToolDefinition,
  ToolAdminEntry,
  ToolAdminPort,
  ToolDefinition,
  ToolRuntimePorts,
} from '../types'
import { ToolNameConflictError, ToolNotFoundError } from '../types'
import { createToolManagementProvider } from './tool-management'

const CALL_OPTIONS = { toolCallId: 'call-1', messages: [], context: {} }

function summaryOf(definition: ToolDefinition): string {
  if (definition.kind === 'http') {
    return `${definition.request.method ?? 'GET'} ${definition.request.url}`
  }
  return definition.timeoutMs ? `sandbox · ${definition.timeoutMs} ms` : 'sandbox'
}

function entry(definition: ToolDefinition): ToolAdminEntry {
  return {
    name: definition.name,
    kind: definition.kind,
    description: definition.description,
    enabled: definition.enabled,
    summary: summaryOf(definition),
  }
}

function httpDefinition(name: string, enabled = true): HttpToolDefinition {
  return {
    kind: 'http',
    name,
    description: `http ${name}`,
    inputSchema: { type: 'object' },
    request: {
      method: 'GET',
      url: 'https://api.example.com/x',
      allowedOrigins: ['https://api.example.com'],
    },
    enabled,
  }
}

function fakeToolAdmin(builtins: string[] = []) {
  const rows = new Map<string, ToolDefinition>()
  const providerNames = new Set(builtins)
  const port: ToolAdminPort = {
    list: () => [...rows.values()].map(entry),
    get: (name) => rows.get(name),
    hasTool: (name) => providerNames.has(name) || rows.has(name),
    async create(definition) {
      if (port.hasTool(definition.name)) throw new ToolNameConflictError(definition.name)
      rows.set(definition.name, definition)
      return entry(definition)
    },
    async update(from, definition) {
      if (!rows.has(from)) throw new ToolNotFoundError(from)
      rows.delete(from)
      rows.set(definition.name, definition)
      return entry(definition)
    },
    async remove(name) {
      rows.delete(name)
    },
  }
  return { port, rows }
}

function ports(toolAdmin?: ToolAdminPort): ToolRuntimePorts {
  return toolAdmin ? { toolAdmin } : {}
}

async function run(name: string, toolAdmin: ToolAdminPort, input: unknown) {
  const provider = createToolManagementProvider()
  const built = provider.create(name, ports(toolAdmin))
  if (!built.execute) throw new Error('missing execute')
  return built.execute(input, CALL_OPTIONS)
}

async function dispatch(
  toolAdmin: ToolAdminPort,
  input: unknown,
  extra: Partial<ToolRuntimePorts> = {},
) {
  const provider = createToolManagementProvider()
  const built = provider.create('call_user_tool', { toolAdmin, ...extra })
  if (!built.execute) throw new Error('missing execute')
  return built.execute(input, CALL_OPTIONS)
}

function okFetch(onUrl: (url: string) => void): typeof fetch {
  return (async (url: string | URL | Request) => {
    onUrl(String(url))
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

const SANDBOX_SOURCE = 'return input'

describe('tool management provider', () => {
  it('is unavailable without a tool admin port', () => {
    const provider = createToolManagementProvider()
    expect(provider.isAvailable(ports())).toBe(false)
    expect(provider.isAvailable(ports(fakeToolAdmin().port))).toBe(true)
  })

  it('creates an http tool with no enabled field and returns it disabled', async () => {
    const admin = fakeToolAdmin()
    const result = await run('create_tool', admin.port, {
      kind: 'http',
      name: 'fetch_thing',
      description: 'Fetch',
      inputSchema: { type: 'object' },
      request: { method: 'GET', url: 'https://api.example.com/x', allowedOrigins: ['https://api.example.com'] },
    })
    expect(result).toMatchObject({ ok: true, code: 'ok' })
    expect((result as { value: { enabled: boolean } }).value.enabled).toBe(false)
    expect(admin.rows.get('fetch_thing')?.enabled).toBe(false)
  })

  it('rejects a bad URL or malformed name as invalid_input', async () => {
    const admin = fakeToolAdmin()
    expect(
      await run('create_tool', admin.port, {
        kind: 'http',
        name: 'bad_url',
        description: '',
        inputSchema: { type: 'object' },
        request: { url: '', allowedOrigins: [] },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(
      await run('create_tool', admin.port, {
        kind: 'sandbox-js',
        name: 'bad name',
        description: '',
        inputSchema: { type: 'object' },
        source: SANDBOX_SOURCE,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('rejects a request template whose placeholder would never interpolate', async () => {
    const admin = fakeToolAdmin()
    const result = await run('create_tool', admin.port, {
      kind: 'http',
      name: 'demo_get_post',
      description: '',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      request: {
        url: 'https://api.example.com/posts/{{id}}',
        allowedOrigins: ['https://api.example.com'],
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' })
    expect((result as { message: string }).message).toContain('{{id}}')
    expect(admin.rows.has('demo_get_post')).toBe(false)
  })

  it('rejects a builtin or existing user name with conflict', async () => {
    const admin = fakeToolAdmin(['read_file'])
    expect(
      await run('create_tool', admin.port, {
        kind: 'sandbox-js',
        name: 'read_file',
        description: '',
        inputSchema: { type: 'object' },
        source: SANDBOX_SOURCE,
      }),
    ).toMatchObject({ ok: false, code: 'conflict' })

    await admin.port.create(httpDefinition('existing'))
    expect(
      await run('create_tool', admin.port, {
        kind: 'http',
        name: 'existing',
        description: '',
        inputSchema: { type: 'object' },
        request: { url: 'https://api.example.com/x', allowedOrigins: ['https://api.example.com'] },
      }),
    ).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('updates a tool in place and preserves kind', async () => {
    const admin = fakeToolAdmin()
    admin.rows.set(
      'sandbox_echo',
      {
        kind: 'sandbox-js',
        name: 'sandbox_echo',
        description: 'before',
        inputSchema: { type: 'object' },
        source: SANDBOX_SOURCE,
        enabled: false,
      },
    )

    const result = await run('update_tool', admin.port, { from: 'sandbox_echo', description: 'after' })

    expect(result).toMatchObject({ ok: true, code: 'ok' })
    expect((result as { value: { kind: string } }).value.kind).toBe('sandbox-js')
    expect(admin.rows.get('sandbox_echo')?.description).toBe('after')
  })

  it('renames a tool and rejects a rename onto an existing name', async () => {
    const admin = fakeToolAdmin(['read_file'])
    admin.rows.set('old', httpDefinition('old'))

    const renamed = await run('update_tool', admin.port, { from: 'old', name: 'new' })
    expect(renamed).toMatchObject({ ok: true, code: 'ok' })
    expect(admin.rows.has('old')).toBe(false)
    expect(admin.rows.has('new')).toBe(true)

    expect(await run('update_tool', admin.port, { from: 'new', name: 'read_file' })).toMatchObject({
      ok: false,
      code: 'conflict',
    })
  })

  it('returns not_found or ok from delete_tool', async () => {
    const admin = fakeToolAdmin()
    expect(await run('delete_tool', admin.port, { name: 'ghost' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    admin.rows.set('gone', httpDefinition('gone'))
    expect(await run('delete_tool', admin.port, { name: 'gone' })).toMatchObject({
      ok: true,
      code: 'ok',
    })
    expect(admin.rows.has('gone')).toBe(false)
  })

  it('calls a user tool created in the same turn through call_user_tool', async () => {
    const admin = fakeToolAdmin()
    await admin.port.create({
      ...httpDefinition('fresh_tool'),
      request: {
        method: 'GET',
        url: 'https://api.example.com/posts/{{input.id}}',
        allowedOrigins: ['https://api.example.com'],
      },
    })

    let seen = ''
    const result = await dispatch(
      admin.port,
      { name: 'fresh_tool', input: { id: '7' } },
      { fetch: okFetch((url) => (seen = url)) },
    )

    expect(result).toMatchObject({ ok: true, code: 'ok' })
    expect(seen).toBe('https://api.example.com/posts/7')
  })

  it('reports an unknown or disabled target instead of calling it', async () => {
    const admin = fakeToolAdmin()
    expect(await dispatch(admin.port, { name: 'nope' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })

    await admin.port.create(httpDefinition('off_tool', false))
    expect(await dispatch(admin.port, { name: 'off_tool' })).toMatchObject({
      ok: false,
      code: 'disabled',
    })
  })

  it('refuses a target the approval policy denies', async () => {
    const admin = fakeToolAdmin()
    await admin.port.create(httpDefinition('denied_tool'))

    let called = false
    const result = await dispatch(
      admin.port,
      { name: 'denied_tool' },
      {
        approvals: { decision: () => 'deny' },
        fetch: okFetch(() => (called = true)),
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'denied' })
    expect(called).toBe(false)
  })
})
