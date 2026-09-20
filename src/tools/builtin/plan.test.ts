import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { PlanItem } from '../../chat/types'
import { ToolRegistry } from '../registry'
import { ToolRuntimeUnavailableError } from '../types'
import type { ThreadPlanPort } from '../types'
import { createPlanToolProvider } from './plan'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function recordingPort(initial: PlanItem[] = []): ThreadPlanPort & { writes: PlanItem[][] } {
  let current = initial
  const writes: PlanItem[][] = []
  return {
    writes,
    get: () => current,
    set: async (items) => {
      writes.push([...items])
      current = [...items]
    },
  }
}

function build(port: ThreadPlanPort | undefined) {
  const registry = new ToolRegistry()
  registry.registerProvider(createPlanToolProvider())
  return registry.buildToolSet(undefined, port ? { plan: port } : {})
}

describe('createPlanToolProvider', () => {
  it('contributes exactly update_plan and gates availability on the port', () => {
    const provider = createPlanToolProvider()
    expect(provider.names).toEqual(['update_plan'])
    expect(provider.isAvailable({})).toBe(false)
    expect(provider.isAvailable({ plan: recordingPort() })).toBe(true)
    expect(Object.keys(build(recordingPort()))).toEqual(['update_plan'])
  })

  it('writes the normalized list and returns items and counts', async () => {
    const port = recordingPort()
    const set = build(port)
    await expect(
      executor(set, 'update_plan')({ items: [{ text: 'one' }, { text: 'two', status: 'completed' }] }, CALL),
    ).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: {
        items: [
          { id: 'p1', text: 'one', status: 'pending' },
          { id: 'p2', text: 'two', status: 'completed' },
        ],
        counts: { pending: 1, in_progress: 0, completed: 1, cancelled: 0 },
      },
    })
    expect(port.writes).toHaveLength(1)
  })

  it('replaces rather than merges', async () => {
    const port = recordingPort([{ id: 'p1', text: 'old', status: 'pending' }])
    const set = build(port)
    await executor(set, 'update_plan')({ items: [{ id: 'p1', text: 'new', status: 'completed' }] }, CALL)
    expect(port.get()).toEqual([{ id: 'p1', text: 'new', status: 'completed' }])
  })

  it('returns invalid_input and does not write for malformed input', async () => {
    const port = recordingPort([{ id: 'p1', text: 'existing', status: 'pending' }])
    const set = build(port)
    await expect(executor(set, 'update_plan')({}, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    await expect(
      executor(set, 'update_plan')({ items: [{ text: 'x', status: 'nope' }] }, CALL),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
    expect(port.writes).toHaveLength(0)
  })

  it('reflects the current plan in the invalid_input hint', async () => {
    const port = recordingPort([{ id: 'abc', text: 'existing', status: 'pending' }])
    const set = build(port)
    const result = (await executor(set, 'update_plan')({}, CALL)) as { hint?: string }
    expect(result.hint).toContain('abc')
  })

  it('returns a runtime_error envelope when the write rejects', async () => {
    const port: ThreadPlanPort = {
      get: () => [],
      set: async () => {
        throw new Error('locked')
      },
    }
    const set = build(port)
    await expect(executor(set, 'update_plan')({ items: [{ text: 'x' }] }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: 'locked',
    })
  })

  it('throws ToolRuntimeUnavailableError without a port', async () => {
    const created = createPlanToolProvider().create('update_plan', {})
    const execute = created.execute
    if (!execute) throw new Error('missing execute')
    await expect(execute({ items: [] }, CALL)).rejects.toBeInstanceOf(ToolRuntimeUnavailableError)
  })
})
