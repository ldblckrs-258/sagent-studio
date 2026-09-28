import { describe, expect, it } from 'vitest'
import { jsonSchema, tool } from 'ai'
import type { Tool } from 'ai'
import type { CodeRunner } from '../sandbox/types'
import { ToolRegistry } from './registry'
import {
  ToolNameConflictError,
  ToolNotFoundError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
} from './types'
import type {
  ExternalToolEntry,
  SandboxJsToolDefinition,
  ToolDefinition,
  ToolProvider,
  ToolRuntimePorts,
} from './types'

function provider(names: string[], available = true): ToolProvider {
  return {
    names,
    isAvailable: () => available,
    create: (name: string): Tool =>
      tool({
        description: `builtin ${name}`,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => `${name}:ok`,
      }),
  }
}

function httpTool(name: string, enabled = true): ToolDefinition {
  return {
    kind: 'http',
    name,
    description: `http ${name}`,
    inputSchema: { type: 'object' },
    request: { method: 'GET', url: 'https://api.example.com/x', allowedOrigins: ['https://api.example.com'] },
    enabled,
  }
}

function sandboxTool(name: string, enabled = true, timeoutMs?: number): ToolDefinition {
  const base: SandboxJsToolDefinition = {
    kind: 'sandbox-js',
    name,
    description: `sandbox ${name}`,
    inputSchema: { type: 'object' },
    source: 'return input',
    enabled,
  }
  return timeoutMs === undefined ? base : { ...base, timeoutMs }
}

const CALL_OPTIONS = { toolCallId: 'call-1', messages: [], context: {} }

function fakeRunner(): CodeRunner & { calls: Array<{ source: string; timeoutMs?: number }> } {
  const calls: Array<{ source: string; timeoutMs?: number }> = []
  return {
    calls,
    run: async (source, options) => {
      calls.push({ source, timeoutMs: options.timeoutMs })
      return { stdout: 'ok', stderr: '', result: 'ok' }
    },
  }
}

describe('ToolRegistry', () => {
  it('builds a deterministic tool set from providers and enabled user tools', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    registry.registerUserTool(httpTool('fetch_thing'))

    const toolSet = registry.buildToolSet(undefined, {})
    expect(Object.keys(toolSet)).toEqual(['fetch_thing', 'read_file'])
  })

  it('excludes disabled user tools from the pool', () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('off_tool', false))
    expect(registry.availableNames({})).toEqual([])
    expect(registry.buildToolSet(undefined, {})).toEqual({})
  })

  it('rejects unknown requested names by dropping them', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    expect(Object.keys(registry.buildToolSet(['nope'], {}))).toEqual([])
  })

  it('narrows to the requested intersection with the available pool', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file', 'write_file']))
    expect(Object.keys(registry.buildToolSet(['write_file'], {}))).toEqual(['write_file'])
  })

  it('excludes providers that are unavailable in the given ports', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file'], false))
    expect(registry.buildToolSet(undefined, {})).toEqual({})
  })

  it('rejects a sandbox-js execution without a code runner', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(sandboxTool('sandbox_echo'))
    const toolSet = registry.buildToolSet(undefined, {})
    const execute = toolSet.sandbox_echo.execute
    if (!execute) throw new Error('missing execute')
    await expect(
      execute({}, CALL_OPTIONS),
    ).rejects.toBeInstanceOf(ToolRuntimeUnavailableError)
  })

  it('binds the tool input into the sandbox source and forwards the timeout', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(sandboxTool('sandbox_echo', true, 250))
    const runner = fakeRunner()
    const ports: ToolRuntimePorts = { codeRunner: runner }
    const toolSet = registry.buildToolSet(undefined, ports)
    const execute = toolSet.sandbox_echo.execute
    if (!execute) throw new Error('missing execute')

    await expect(execute({ value: 1 }, CALL_OPTIONS)).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      value: { result: 'ok' },
    })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].source).toContain('const input = {"value":1};')
    expect(runner.calls[0].timeoutMs).toBe(250)
  })

  it('executes an http tool through the injected fetch', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('fetch_thing'))
    let seen = ''
    const fetchImpl = (async (url: string | URL | Request) => {
      seen = String(url)
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    const toolSet = registry.buildToolSet(undefined, { fetch: fetchImpl })
    const execute = toolSet.fetch_thing.execute
    if (!execute) throw new Error('missing execute')

    await expect(execute({}, CALL_OPTIONS)).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      value: { status: 200 },
    })
    expect(seen).toBe('https://api.example.com/x')
  })

  it('surfaces an http failure as an http_error envelope', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('fetch_thing'))
    const fetchImpl = (async () => new Response('boom', { status: 503 })) as typeof fetch
    const toolSet = registry.buildToolSet(undefined, { fetch: fetchImpl })
    const execute = toolSet.fetch_thing.execute
    if (!execute) throw new Error('missing execute')
    await expect(execute({}, CALL_OPTIONS)).resolves.toMatchObject({ ok: false, code: 'http_error' })
  })

  it('rejects a duplicate name across providers and user tools', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    expect(() => registry.registerUserTool(httpTool('read_file'))).toThrow(ToolNameConflictError)
  })

  it('rejects an unsafe schema key', () => {
    const registry = new ToolRegistry()
    const definition = httpTool('evil')
    definition.inputSchema = { type: 'object', properties: JSON.parse('{"__proto__":{"x":1}}') }
    expect(() => registry.registerUserTool(definition)).toThrow(ToolSchemaError)
  })

  it('rejects an invalid tool name', () => {
    const registry = new ToolRegistry()
    expect(() => registry.registerUserTool(httpTool('bad name'))).toThrow(ToolSchemaError)
  })

  it('hydrates user tools from a store', async () => {
    const store = {
      save: async () => {},
      remove: async () => {},
      list: async () => [httpTool('hydrated')],
    }
    const registry = new ToolRegistry(store)
    await registry.hydrate()
    expect(registry.availableNames({})).toEqual(['hydrated'])
  })

  it('skips already-registered tools on a second hydrate', async () => {
    const store = {
      save: async () => {},
      remove: async () => {},
      list: async () => [httpTool('hydrated')],
    }
    const registry = new ToolRegistry(store)
    await registry.hydrate()
    await expect(registry.hydrate()).resolves.toBeUndefined()
    expect(registry.availableNames({})).toEqual(['hydrated'])
  })

  it('skips a hydrated name that collides with a registered provider', async () => {
    const store = {
      save: async () => {},
      remove: async () => {},
      list: async () => [httpTool('read_file')],
    }
    const registry = new ToolRegistry(store)
    registry.registerProvider(provider(['read_file']))
    await expect(registry.hydrate()).resolves.toBeUndefined()
  })

  it('removes a user tool and narrows the available pool', () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('gone'))
    expect(registry.availableNames({})).toEqual(['gone'])
    registry.removeUserTool('gone')
    expect(registry.availableNames({})).toEqual([])
    expect(() => registry.removeUserTool('gone')).toThrow(ToolNotFoundError)
  })

  it('reports name ownership through hasTool for providers and user tools', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    registry.registerUserTool(httpTool('fetch_thing'))
    expect(registry.hasTool('read_file')).toBe(true)
    expect(registry.hasTool('fetch_thing')).toBe(true)
    expect(registry.hasTool('missing')).toBe(false)
  })

  it('exposes its injected store', () => {
    const store = { save: async () => {}, remove: async () => {}, list: async () => [] }
    expect(new ToolRegistry(store).store()).toBe(store)
  })

  it('replaces an existing user tool in place without a self-conflict', () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('fetch_thing', false))
    registry.replaceUserTool(httpTool('fetch_thing', true))
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].enabled).toBe(true)
  })

  it('rejects replace for an absent name or a provider-owned name', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    expect(() => registry.replaceUserTool(httpTool('missing'))).toThrow(ToolNotFoundError)
    expect(() => registry.replaceUserTool(httpTool('read_file'))).toThrow(ToolNameConflictError)
  })

  it('bumps the version on every registry mutation', () => {
    const registry = new ToolRegistry()
    const start = registry.getVersion()
    registry.registerProvider(provider(['read_file']))
    const afterProvider = registry.getVersion()
    expect(afterProvider).toBeGreaterThan(start)

    registry.registerUserTool(httpTool('t'))
    const afterRegister = registry.getVersion()
    expect(afterRegister).toBeGreaterThan(afterProvider)

    registry.replaceUserTool(httpTool('t', false))
    const afterReplace = registry.getVersion()
    expect(afterReplace).toBeGreaterThan(afterRegister)

    registry.setEnabled('t', true)
    const afterEnable = registry.getVersion()
    expect(afterEnable).toBeGreaterThan(afterReplace)

    registry.removeUserTool('t')
    expect(registry.getVersion()).toBeGreaterThan(afterEnable)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const registry = new ToolRegistry()
    let first = 0
    let second = 0
    const unsubscribeFirst = registry.subscribe(() => {
      first += 1
    })
    const unsubscribeSecond = registry.subscribe(() => {
      second += 1
    })

    registry.registerUserTool(httpTool('a'))
    expect([first, second]).toEqual([1, 1])

    unsubscribeFirst()
    registry.setEnabled('a', false)
    expect([first, second]).toEqual([1, 2])

    unsubscribeSecond()
    registry.removeUserTool('a')
    expect([first, second]).toEqual([1, 2])
  })

  it('executes the definition the registry holds now, not the one captured at build time', async () => {
    const registry = new ToolRegistry()
    const runner = fakeRunner()
    registry.registerUserTool(sandboxTool('echo'))
    const toolSet = registry.buildToolSet(undefined, { codeRunner: runner })
    const execute = toolSet.echo.execute
    if (!execute) throw new Error('missing execute')

    registry.replaceUserTool({ ...(sandboxTool('echo') as SandboxJsToolDefinition), source: 'return 42' })
    await execute({ a: 1 }, CALL_OPTIONS)

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.source).toContain('return 42')
  })

  it('fails a call whose tool was disabled after the tool set was built', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(sandboxTool('echo'))
    const toolSet = registry.buildToolSet(undefined, { codeRunner: fakeRunner() })
    const execute = toolSet.echo.execute
    if (!execute) throw new Error('missing execute')

    registry.setEnabled('echo', false)
    const result = (await execute({}, CALL_OPTIONS)) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not_found')
  })

  it('toggles enabled state through setEnabled', () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('toggle_me', false))
    expect(registry.availableNames({})).toEqual([])

    registry.setEnabled('toggle_me', true)
    expect(registry.availableNames({})).toEqual(['toggle_me'])

    registry.setEnabled('toggle_me', false)
    expect(registry.availableNames({})).toEqual([])
  })
})

function externalEntry(name: string): ExternalToolEntry {
  return {
    name,
    kind: 'mcp',
    create: () =>
      tool({
        description: `external ${name}`,
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => `${name}:external`,
      }),
  }
}

describe('ToolRegistry external sources', () => {
  it('publishes external tools into the pool and tool set, and replaces them per source', async () => {
    const registry = new ToolRegistry()
    const before = registry.getVersion()
    expect(registry.setExternalTools('mcp:a', [externalEntry('mcp_a_one'), externalEntry('mcp_a_two')])).toEqual([])
    expect(registry.getVersion()).toBeGreaterThan(before)
    expect(registry.availableNames({})).toEqual(['mcp_a_one', 'mcp_a_two'])
    expect(registry.toolKind('mcp_a_one')).toBe('mcp')
    expect(registry.hasTool('mcp_a_two')).toBe(true)

    const set = registry.buildToolSet(['mcp_a_one'], {})
    expect(Object.keys(set)).toEqual(['mcp_a_one'])
    expect(await set.mcp_a_one!.execute!({} as never, CALL_OPTIONS)).toBe('mcp_a_one:external')

    registry.setExternalTools('mcp:a', [externalEntry('mcp_a_three')])
    expect(registry.availableNames({})).toEqual(['mcp_a_three'])
    registry.clearExternalTools('mcp:a')
    expect(registry.availableNames({})).toEqual([])
    expect(registry.toolKind('mcp_a_three')).toBeUndefined()
  })

  it('never lets an external tool shadow a built-in, a user tool, or another source', () => {
    const registry = new ToolRegistry()
    registry.registerProvider(provider(['read_file']))
    registry.registerUserTool(httpTool('mine'))
    registry.setExternalTools('mcp:a', [externalEntry('mcp_shared')])
    const skipped = registry.setExternalTools('mcp:b', [
      externalEntry('read_file'),
      externalEntry('mine'),
      externalEntry('mcp_shared'),
      externalEntry('bad name'),
      externalEntry('mcp_b_ok'),
      externalEntry('mcp_b_ok'),
    ])
    expect(skipped.map((entry) => entry.name)).toEqual([
      'read_file',
      'mine',
      'mcp_shared',
      'bad name',
      'mcp_b_ok',
    ])
    expect(registry.availableNames({})).toEqual(['mcp_b_ok', 'mcp_shared', 'mine', 'read_file'])
    expect(registry.toolKind('read_file')).toBeUndefined()
    expect(registry.toolKind('mine')).toBe('http')
  })

  it('refuses a user tool or provider that would take an external tool name', () => {
    const registry = new ToolRegistry()
    registry.setExternalTools('mcp:a', [externalEntry('mcp_a_one')])
    expect(() => registry.registerUserTool(httpTool('mcp_a_one'))).toThrow(ToolNameConflictError)
    expect(() => registry.registerProvider(provider(['mcp_a_one']))).toThrow(ToolNameConflictError)
  })

  it('lists external tools with their kind for the approvals panel', () => {
    const registry = new ToolRegistry()
    registry.setExternalTools('mcp:b', [externalEntry('mcp_b_z')])
    registry.setExternalTools('mcp:a', [externalEntry('mcp_a_y')])
    expect(registry.listExternal()).toEqual([
      { name: 'mcp_a_y', kind: 'mcp' },
      { name: 'mcp_b_z', kind: 'mcp' },
    ])
    expect(registry.list()).toEqual([])
  })
})
