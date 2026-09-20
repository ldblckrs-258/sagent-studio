import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { SandboxControlPort } from '../types'
import { createSandboxControlProvider } from './sandbox-control'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function recordingPort(): SandboxControlPort & { resets: Array<'js' | 'python' | undefined> } {
  const resets: Array<'js' | 'python' | undefined> = []
  return {
    resets,
    reset: (language) => resets.push(language),
    status: () => ({ js: true, python: true }),
  }
}

function build(port: SandboxControlPort | undefined, enabled = true) {
  const provider = createSandboxControlProvider({
    isEnabled: () => enabled,
    getPort: () => port,
  })
  const registry = new ToolRegistry()
  registry.registerProvider(provider)
  return registry.buildToolSet(undefined, port ? { sandbox: port } : {})
}

describe('createSandboxControlProvider', () => {
  it('contributes exactly reset_sandbox', () => {
    const port = recordingPort()
    const provider = createSandboxControlProvider({ isEnabled: () => true, getPort: () => port })
    expect(provider.names).toEqual(['reset_sandbox'])
    expect(Object.keys(build(port))).toEqual(['reset_sandbox'])
  })

  it('is unavailable when the sandbox is disabled', () => {
    const port = recordingPort()
    const provider = createSandboxControlProvider({ isEnabled: () => false, getPort: () => port })
    expect(provider.isAvailable({})).toBe(false)
  })

  it('throws ToolRuntimeUnavailableError without a port', async () => {
    const set = build(undefined)
    await expect(executor(set, 'reset_sandbox')({}, CALL)).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })

  it('resets both languages by default', async () => {
    const port = recordingPort()
    const set = build(port)
    await expect(executor(set, 'reset_sandbox')({}, CALL)).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: { reset: ['js', 'python'] },
    })
    expect(port.resets).toEqual([undefined])
  })

  it('resets only the requested language', async () => {
    const port = recordingPort()
    const set = build(port)
    await expect(executor(set, 'reset_sandbox')({ language: 'python' }, CALL)).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: { reset: ['python'] },
    })
    expect(port.resets).toEqual(['python'])
  })

  it('rejects an unknown language as invalid_input', async () => {
    const port = recordingPort()
    const set = build(port)
    await expect(executor(set, 'reset_sandbox')({ language: 'ruby' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    expect(port.resets).toEqual([])
  })
})
