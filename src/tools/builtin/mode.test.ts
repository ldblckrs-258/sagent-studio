import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { ChatMode } from '../../chat/types'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { ThreadModePort } from '../types'
import { createModeToolProvider } from './mode'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function build(port: ThreadModePort | undefined) {
  const registry = new ToolRegistry()
  registry.registerProvider(createModeToolProvider())
  return registry.buildToolSet(undefined, port ? { mode: port } : {})
}

describe('createModeToolProvider', () => {
  it('contributes exactly change_mode and is always available', () => {
    const provider = createModeToolProvider()
    expect(provider.names).toEqual(['change_mode'])
    expect(provider.isAvailable({})).toBe(true)
    expect(Object.keys(build(undefined))).toEqual(['change_mode'])
  })

  it('sets the requested mode through the port', async () => {
    const modes: ChatMode[] = []
    const port: ThreadModePort = { setMode: async (mode) => void modes.push(mode) }
    const set = build(port)
    await expect(executor(set, 'change_mode')({ mode: 'read_only' }, CALL)).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: { mode: 'read_only' },
    })
    expect(modes).toEqual(['read_only'])
  })

  it('rejects an unknown mode as invalid_input', async () => {
    const port: ThreadModePort = { setMode: async () => {} }
    const set = build(port)
    await expect(executor(set, 'change_mode')({ mode: 'admin' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
  })

  it('throws ToolRuntimeUnavailableError without a mode port', async () => {
    const set = build(undefined)
    await expect(executor(set, 'change_mode')({ mode: 'god' }, CALL)).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })
})
