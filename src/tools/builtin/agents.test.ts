import type { Tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRunIdentity,
  AgentSpawnOutcome,
  AgentTranscript,
  AgentTurn,
} from '../../agents/types'
import { ToolRuntimeUnavailableError } from '../types'
import type { AgentSpawnPort, ToolRuntimePorts } from '../types'
import { createAgentsToolProvider } from './agents'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function agentsPorts(overrides: Partial<AgentSpawnPort> = {}): ToolRuntimePorts {
  const agents: AgentSpawnPort = {
    spawn: vi.fn(async () => ({ status: 'running', runId: 'run-1' }) as AgentSpawnOutcome),
    stop: vi.fn(() => true),
    read: vi.fn(async () => null as AgentTranscript | null),
    resolveRun: vi.fn(async () => null as AgentRunIdentity | null),
    ...overrides,
  }
  return { agents }
}

function toolFor(ports: ToolRuntimePorts, name: string): Tool {
  return createAgentsToolProvider().create(name, ports)
}

function execute(ports: ToolRuntimePorts, name: string, input: unknown) {
  const run = toolFor(ports, name).execute
  if (!run) throw new Error(`missing execute for ${name}`)
  return run(input, CALL)
}

function transcript(overrides: Partial<AgentTranscript> = {}): AgentTranscript {
  return { runId: 'run-1', status: 'running', turns: [], ...overrides }
}

function portReturning(outcome: AgentSpawnOutcome, spawn = vi.fn(async () => outcome)) {
  return { spawn, ports: agentsPorts({ spawn }) }
}

describe('spawn_agent tool', () => {
  it('returns an awaited agent result as an untrusted tool result', async () => {
    const { ports, spawn } = portReturning({
      status: 'completed',
      runId: 'run-1',
      label: 'scout',
      result: { status: 'completed', mode: 'read_only', tier: 'cheap', text: 'found it', toolCalls: 2 },
    })
    const result = (await execute(ports, 'spawn_agent', { prompt: 'look around' })) as {
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
    const result = (await execute(ports, 'spawn_agent', {
      prompt: 'work in the background',
      background: true,
    })) as { ok: boolean; value: { status: string; runId: string } }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ status: 'running', runId: 'run-9', label: 'bg' })
  })

  it('honors an explicit mode and tier', async () => {
    const { ports, spawn } = portReturning({
      status: 'completed',
      runId: 'run-1',
      result: { status: 'completed', mode: 'god', tier: 'max', text: '', toolCalls: 0 },
    })
    await execute(ports, 'spawn_agent', { prompt: 'advise', mode: 'god', tier: 'max' })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'god', tier: 'max' }),
      expect.anything(),
    )
  })

  it('rejects invalid input without calling the runtime', async () => {
    const { ports, spawn } = portReturning({ status: 'running', runId: 'r' })
    const result = (await execute(ports, 'spawn_agent', { prompt: '   ' })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an unknown tier', async () => {
    const { ports, spawn } = portReturning({ status: 'running', runId: 'r' })
    const result = (await execute(ports, 'spawn_agent', { prompt: 'go', tier: 'ultra' })) as {
      ok: boolean
      code: string
    }
    expect(result.code).toBe('invalid_input')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a failed awaited run as a tool failure, not empty success', async () => {
    const { ports } = portReturning({
      status: 'completed',
      runId: 'run-1',
      result: {
        status: 'invalid_input',
        mode: 'read_only',
        tier: 'cheap',
        text: '',
        toolCalls: 0,
        error: 'No enabled skill is named "missing".',
      },
    })
    const result = (await execute(ports, 'spawn_agent', { prompt: 'go', skills: ['missing'] })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
  })

  it('maps a runtime limit to limit_exceeded', async () => {
    const { ports } = portReturning({ status: 'limit_exceeded', message: 'too many' })
    const result = (await execute(ports, 'spawn_agent', { prompt: 'go' })) as { code: string }
    expect(result.code).toBe('limit_exceeded')
  })

  it('throws the runtime-unavailable error when no port is attached', async () => {
    await expect(execute({}, 'spawn_agent', { prompt: 'go' })).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })
})

describe('stop_agent tool', () => {
  it('stops a run by exact runId', async () => {
    const stop = vi.fn(() => true)
    const ports = agentsPorts({ stop })
    const result = (await execute(ports, 'stop_agent', { runId: 'run-9' })) as {
      ok: boolean
      value: { runId: string; stopped: boolean; reason: string }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ runId: 'run-9', stopped: true, reason: 'user_stop' })
    expect(stop).toHaveBeenCalledWith('run-9', 'user_stop')
  })

  it('resolves a unique label to its runId before stopping', async () => {
    const stop = vi.fn(() => true)
    const resolveRun = vi.fn(
      async () => ({ runId: 'run-3', label: 'scout', status: 'running' }) as AgentRunIdentity,
    )
    const ports = agentsPorts({ stop, resolveRun })
    const result = (await execute(ports, 'stop_agent', { label: 'scout' })) as {
      ok: boolean
      value: { runId: string; label: string }
    }
    expect(result.value).toMatchObject({ runId: 'run-3', label: 'scout' })
    expect(resolveRun).toHaveBeenCalledWith({ label: 'scout' })
    expect(stop).toHaveBeenCalledWith('run-3', 'user_stop')
  })

  it('rejects an ambiguous or missing label without stopping', async () => {
    const stop = vi.fn(() => true)
    const resolveRun = vi.fn(async () => null as AgentRunIdentity | null)
    const ports = agentsPorts({ stop, resolveRun })
    const result = (await execute(ports, 'stop_agent', { label: 'twin' })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(stop).not.toHaveBeenCalled()
  })

  it('rejects input without an identifier', async () => {
    const stop = vi.fn(() => true)
    const ports = agentsPorts({ stop })
    const result = (await execute(ports, 'stop_agent', {})) as { ok: boolean; code: string }
    expect(result.code).toBe('invalid_input')
    expect(stop).not.toHaveBeenCalled()
  })

  it('reports a run the runtime refused to stop', async () => {
    const ports = agentsPorts({ stop: vi.fn(() => false) })
    const result = (await execute(ports, 'stop_agent', { runId: 'run-9' })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('runtime_error')
  })

  it('reports a runtime without a stop method', async () => {
    const ports = agentsPorts({ stop: undefined })
    const result = (await execute(ports, 'stop_agent', { runId: 'run-9' })) as { code: string }
    expect(result.code).toBe('runtime_error')
  })

  it('throws the runtime-unavailable error when no port is attached', async () => {
    await expect(execute({}, 'stop_agent', { runId: 'run-9' })).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })
})

describe('read_agent tool', () => {
  it('returns bounded turns marked untrusted', async () => {
    const turns: AgentTurn[] = [
      { role: 'user', text: 'find it' },
      { role: 'assistant', text: 'found it' },
    ]
    const read = vi.fn(async () => transcript({ turns }))
    const ports = agentsPorts({ read })
    const result = (await execute(ports, 'read_agent', { runId: 'run-1' })) as {
      ok: boolean
      value: { runId: string; status: string; turns: AgentTurn[]; untrusted: boolean }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ runId: 'run-1', status: 'running', untrusted: true })
    expect(result.value.turns).toEqual(turns)
    expect(read).toHaveBeenCalledWith('run-1', { lastN: 6, includeTools: false })
  })

  it('clamps lastN into 1..50 and passes includeTools through', async () => {
    const read = vi.fn(async () => transcript())
    const ports = agentsPorts({ read })
    await execute(ports, 'read_agent', { runId: 'run-1', lastN: 999, includeTools: true })
    expect(read).toHaveBeenLastCalledWith('run-1', { lastN: 50, includeTools: true })
    await execute(ports, 'read_agent', { runId: 'run-1', lastN: 0 })
    expect(read).toHaveBeenLastCalledWith('run-1', { lastN: 1, includeTools: false })
    await execute(ports, 'read_agent', { runId: 'run-1', lastN: -4.2 })
    expect(read).toHaveBeenLastCalledWith('run-1', { lastN: 1, includeTools: false })
  })

  it('returns turns verbatim, without truncating long text', async () => {
    const long = 'x'.repeat(20000)
    const read = vi.fn(async () =>
      transcript({ turns: [{ role: 'assistant', text: long }] }),
    )
    const ports = agentsPorts({ read })
    const result = (await execute(ports, 'read_agent', { runId: 'run-1' })) as {
      truncated?: boolean
      value: { turns: AgentTurn[] }
    }
    expect(result.truncated).toBeUndefined()
    expect(result.value.turns[0]?.text).toBe(long)
  })

  it('carries the stop reason of a settled run', async () => {
    const read = vi.fn(async () =>
      transcript({ status: 'stopped', stopReason: 'user_stop', turns: [{ role: 'user', text: 'hey' }] }),
    )
    const ports = agentsPorts({ read })
    const result = (await execute(ports, 'read_agent', { runId: 'run-1' })) as {
      value: { status: string; stopReason: string }
    }
    expect(result.value).toMatchObject({ status: 'stopped', stopReason: 'user_stop' })
  })

  it('resolves a unique label before reading', async () => {
    const read = vi.fn(async () => transcript({ runId: 'run-3', label: 'scout' }))
    const resolveRun = vi.fn(
      async () => ({ runId: 'run-3', label: 'scout', status: 'running' }) as AgentRunIdentity,
    )
    const ports = agentsPorts({ read, resolveRun })
    const result = (await execute(ports, 'read_agent', { label: 'scout' })) as {
      value: { runId: string; label: string }
    }
    expect(result.value).toMatchObject({ runId: 'run-3', label: 'scout' })
    expect(read).toHaveBeenCalledWith('run-3', { lastN: 6, includeTools: false })
  })

  it('rejects an ambiguous label without reading', async () => {
    const read = vi.fn(async () => transcript())
    const resolveRun = vi.fn(async () => null as AgentRunIdentity | null)
    const ports = agentsPorts({ read, resolveRun })
    const result = (await execute(ports, 'read_agent', { label: 'twin' })) as {
      ok: boolean
      code: string
    }
    expect(result.code).toBe('invalid_input')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects input without an identifier', async () => {
    const read = vi.fn(async () => transcript())
    const ports = agentsPorts({ read })
    const result = (await execute(ports, 'read_agent', {})) as { code: string }
    expect(result.code).toBe('invalid_input')
    expect(read).not.toHaveBeenCalled()
  })

  it('reports a run the runtime cannot read', async () => {
    const ports = agentsPorts({ read: vi.fn(async () => null as AgentTranscript | null) })
    const result = (await execute(ports, 'read_agent', { runId: 'gone' })) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
  })

  it('reports a runtime without a read method', async () => {
    const ports = agentsPorts({ read: undefined })
    const result = (await execute(ports, 'read_agent', { runId: 'run-1' })) as { code: string }
    expect(result.code).toBe('runtime_error')
  })

  it('throws the runtime-unavailable error when no port is attached', async () => {
    await expect(execute({}, 'read_agent', { runId: 'run-1' })).rejects.toBeInstanceOf(
      ToolRuntimeUnavailableError,
    )
  })
})
