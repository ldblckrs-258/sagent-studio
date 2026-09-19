import { describe, expect, it } from 'vitest'
import { jsonSchema, tool } from 'ai'
import type { Tool } from 'ai'
import type { CodeRunner } from '../sandbox/types'
import { ToolRegistry } from './registry'
import {
  HttpToolError,
  ToolNameConflictError,
  ToolNotFoundError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
} from './types'
import type { SandboxJsToolDefinition, ToolDefinition, ToolProvider, ToolRuntimePorts } from './types'

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

    await execute({ value: 1 }, CALL_OPTIONS)
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
      status: 200,
    })
    expect(seen).toBe('https://api.example.com/x')
  })

  it('surfaces an http failure as HttpToolError', async () => {
    const registry = new ToolRegistry()
    registry.registerUserTool(httpTool('fetch_thing'))
    const fetchImpl = (async () => new Response('boom', { status: 503 })) as typeof fetch
    const toolSet = registry.buildToolSet(undefined, { fetch: fetchImpl })
    const execute = toolSet.fetch_thing.execute
    if (!execute) throw new Error('missing execute')
    await expect(execute({}, CALL_OPTIONS)).rejects.toBeInstanceOf(HttpToolError)
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
