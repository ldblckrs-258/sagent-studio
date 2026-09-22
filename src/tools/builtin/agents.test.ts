import type { ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSpawnOutcome } from '../../agents/types'
import { ToolRuntimeUnavailableError } from '../types'
import type { ToolRuntimePorts } from '../types'
import { createAgentsToolProvider } from './agents'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function spawnTool(ports: ToolRuntimePorts): ToolSet {
  const provider = createAgentsToolProvider()
  return { spawn_agent: provider.create('spawn_agent', ports) }
}

function execute(set: ToolSet, input: unknown) {
  const run = set.spawn_agent?.execute
  if (!run) throw new Error('missing execute')
  return run(input, CALL)
}

function portReturning(outcome: AgentSpawnOutcome, spawn = vi.fn(async () => outcome)) {
  return { spawn, ports: { agents: { spawn } } as ToolRuntimePorts }
}

describe('spawn_agent tool', () => {
  it('returns an awaited agent result as an untrusted tool result', async () => {
    const { ports, spawn } = portReturning({
      status: 'completed',
      label: 'scout',
      result: { status: 'completed', mode: 'read_only', tier: 'cheap', text: 'found it', toolCalls: 2 },
    })
    const result = (await execute(spawnTool(ports), { prompt: 'look around' })) as {
      ok: boolean
      value: { status: string; result: string; untrusted: boolean; toolCalls: number }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      status: 'completed',
      result: 'found it',
      untrusted: true,
      toolCalls: 2,
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'look around', mode: 'read_only', tier: 'cheap', background: false }),
      expect.anything(),
    )
  })

  it('returns a run handle for a background agent', async () => {
    const { ports } = portReturning({ status: 'running', runId: 'run-9', label: 'bg' })
    const result = (await execute(spawnTool(ports), {
      prompt: 'work in the background',
      background: true,
    })) as { ok: boolean; value: { status: string; runId: string } }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ status: 'running', runId: 'run-9', label: 'bg' })
  })

  it('honors an explicit mode and tier', async () => {
    const { ports, spawn } = portReturning({
      status: 'completed',
      result: { status: 'completed', mode: 'god', tier: 'max', text: '', toolCalls: 0 },
    })
    await execute(spawnTool(ports), { prompt: 'advise', mode: 'god', tier: 'max' })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'god', tier: 'max' }),
      expect.anything(),
    )
  })

  it('rejects invalid input without calling the runtime', async () => {
    const { ports, spawn } = portReturning({ status: 'running', runId: 'r' })
    const result = (await execute(spawnTool(ports), { prompt: '   ' })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an unknown tier', async () => {
    const { ports, spawn } = portReturning({ status: 'running', runId: 'r' })
    const result = (await execute(spawnTool(ports), { prompt: 'go', tier: 'ultra' })) as {
      ok: boolean
      code: string
    }
    expect(result.code).toBe('invalid_input')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a failed awaited run as a tool failure, not empty success', async () => {
    const { ports } = portReturning({
      status: 'completed',
      result: {
        status: 'invalid_input',
        mode: 'read_only',
        tier: 'cheap',
        text: '',
        toolCalls: 0,
        error: 'No enabled skill is named "missing".',
      },
    })
    const result = (await execute(spawnTool(ports), { prompt: 'go', skills: ['missing'] })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
  })

  it('maps a runtime limit to limit_exceeded', async () => {
    const { ports } = portReturning({ status: 'limit_exceeded', message: 'too many' })
    const result = (await execute(spawnTool(ports), { prompt: 'go' })) as { code: string }
    expect(result.code).toBe('limit_exceeded')
  })

  it('throws the runtime-unavailable error when no port is attached', async () => {
    await expect(execute(spawnTool({}), { prompt: 'go' })).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })
})
