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

  it('returns the structured value and its error field from an awaited run', async () => {
    const { ports, spawn } = portReturning({
      status: 'completed',
      runId: 'run-1',
      result: {
        status: 'completed',
        mode: 'read_only',
        tier: 'cheap',
        text: 'counted',
        toolCalls: 0,
        structured: { count: 3 },
      },
    })
    const schema = { type: 'object', properties: { count: { type: 'integer' } } }
    const result = (await execute(ports, 'spawn_agent', { prompt: 'count', outputSchema: schema })) as {
      ok: boolean
      value: { structured?: unknown; structuredError?: string }
    }

    expect(result.ok).toBe(true)
    expect(result.value.structured).toEqual({ count: 3 })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ outputSchema: schema }), expect.anything())
  })

  it('rejects a bad outputSchema before any run starts', async () => {
    const { ports, spawn } = portReturning({ status: 'running', runId: 'run-1' })
    const notObject = (await execute(ports, 'spawn_agent', {
      prompt: 'count',
      outputSchema: { type: 'array' },
    })) as { ok: boolean; code: string }
    const tooLarge = (await execute(ports, 'spawn_agent', {
      prompt: 'count',
      outputSchema: { type: 'object', description: 'x'.repeat(9000) },
    })) as { ok: boolean; code: string }

    expect(notObject.ok).toBe(false)
    expect(notObject.code).toBe('invalid_input')
    expect(tooLarge.ok).toBe(false)
    expect(tooLarge.code).toBe('invalid_input')
    expect(spawn).not.toHaveBeenCalled()
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

describe('message_agent tool', () => {
  it('steers a running run and reports the delivery', async () => {
    const steer = vi.fn(() => true)
    const cont = vi.fn()
    const ports = agentsPorts({
      steer,
      continue: cont,
      resolveRun: vi.fn(async () => ({ runId: 'run-1', label: 'scout', status: 'running' as const })),
    })

    const result = (await execute(ports, 'message_agent', { runId: 'run-1', message: 'focus on auth' })) as {
      ok: boolean
      value: unknown
    }

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ delivered: 'steer', runId: 'run-1', label: 'scout' })
    expect(steer).toHaveBeenCalledWith('run-1', 'focus on auth')
    expect(cont).not.toHaveBeenCalled()
  })

  it('continues a settled run and returns its new result like spawn_agent', async () => {
    const cont = vi.fn(async () => ({
      status: 'completed' as const,
      runId: 'run-1',
      label: 'scout',
      result: { status: 'completed' as const, mode: 'read_only' as const, tier: 'cheap' as const, text: 'checked', toolCalls: 1 },
    }))
    const ports = agentsPorts({
      continue: cont,
      resolveRun: vi.fn(async () => ({ runId: 'run-1', label: 'scout', status: 'completed' as const })),
    })

    const result = (await execute(ports, 'message_agent', { label: 'scout', message: 'check tests too' })) as {
      ok: boolean
      value: { delivered: string; status: string; result: string; untrusted: boolean }
    }

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ delivered: 'continue', status: 'completed', result: 'checked', untrusted: true })
    expect(cont).toHaveBeenCalledWith('run-1', 'check tests too', { background: false })
  })

  it('returns a run handle when a settled run is continued in the background', async () => {
    const cont = vi.fn(async () => ({ status: 'running' as const, runId: 'run-1' }))
    const ports = agentsPorts({
      continue: cont,
      resolveRun: vi.fn(async () => ({ runId: 'run-1', status: 'stopped' as const })),
    })

    const result = (await execute(ports, 'message_agent', {
      runId: 'run-1',
      message: 'resume',
      background: true,
    })) as { ok: boolean; value: unknown }

    expect(result.value).toEqual({ delivered: 'continue', status: 'running', runId: 'run-1' })
  })

  it('surfaces a refused continuation, such as a legacy run', async () => {
    const ports = agentsPorts({
      continue: vi.fn(async () => ({ status: 'invalid_input' as const, message: 'recorded before runs could be continued' })),
      resolveRun: vi.fn(async () => ({ runId: 'old', status: 'completed' as const })),
    })

    const result = (await execute(ports, 'message_agent', { runId: 'old', message: 'hi' })) as {
      ok: boolean
      code: string
    }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
  })

  it('rejects a run this conversation cannot see and an empty message', async () => {
    const ports = agentsPorts({ resolveRun: vi.fn(async () => null) })

    const unknown = (await execute(ports, 'message_agent', { runId: 'nope', message: 'hi' })) as { ok: boolean }
    const empty = (await execute(ports, 'message_agent', { runId: 'run-1', message: '  ' })) as { ok: boolean }

    expect(unknown.ok).toBe(false)
    expect(empty.ok).toBe(false)
  })
})

describe('wait_agents tool', () => {
  it('passes targets, mode, timeout, and the turn signal to the runtime and returns the gathered runs', async () => {
    const wait = vi.fn(async () => ({
      ok: true as const,
      timedOut: false,
      aborted: false,
      runs: [{ runId: 'run-1', label: 'a', status: 'completed' as const, result: 'done' }],
    }))
    const ports = agentsPorts({ wait })
    const run = toolFor(ports, 'wait_agents').execute
    if (!run) throw new Error('missing execute')
    const controller = new AbortController()

    const result = (await run(
      { labels: ['a'], mode: 'any', timeoutMs: 1000 },
      { ...CALL, abortSignal: controller.signal },
    )) as { ok: boolean; value: { runs: unknown[]; mode: string; untrusted: boolean } }

    expect(wait).toHaveBeenCalledWith({ labels: ['a'], mode: 'any', timeoutMs: 1000 }, controller.signal)
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ mode: 'any', untrusted: true })
    expect(result.value.runs).toHaveLength(1)
  })

  it('rejects malformed input and a refused target', async () => {
    const wait = vi.fn(async () => ({ ok: false as const, message: 'No run x is visible to this conversation.' }))
    const ports = agentsPorts({ wait })

    const malformed = (await execute(ports, 'wait_agents', { mode: 'some' })) as { ok: boolean; code: string }
    const refused = (await execute(ports, 'wait_agents', { runIds: ['x'] })) as { ok: boolean; code: string }

    expect(malformed).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(refused).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(wait).toHaveBeenCalledTimes(1)
  })
})
