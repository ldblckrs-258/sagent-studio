import { describe, expect, it } from 'vitest'
import type { ChatMode } from '../chat/types'
import type { ApprovalDecision } from '../vault/settings'
import {
  LANE_REASON,
  commandApprovalFor,
  consumeApproval,
  createCommandLane,
  describeCommandInput,
  type CommandApprovalResult,
} from './approval'
import { createFakePort, fakeSession } from './test-utils/fake-port'

const SENSITIVE = { sensitive: true, reasons: ['recursive delete'], commands: ['rm'] }
const SAFE = { sensitive: false, reasons: [], commands: ['ls'] }

function port() {
  return createFakePort({ classify: (command) => (command.startsWith('rm') ? SENSITIVE : SAFE) })
}

function decide(
  mode: ChatMode,
  command: string,
  persisted?: ApprovalDecision,
  p = port(),
  name = 'run_command',
): Promise<CommandApprovalResult> {
  return commandApprovalFor(
    p,
    { threadId: 't1', mode, settings: { tools: persisted ? { [name]: persisted } : {} } },
    name,
    { command },
    `call-${Math.random()}`,
  )
}

describe('policy table', () => {
  const rows: [ChatMode, ApprovalDecision | undefined, string, CommandApprovalResult['type']][] = [
    ['read_only', undefined, 'ls', 'user-approval'],
    ['read_only', undefined, 'rm -rf x', 'user-approval'],
    ['read_only', 'deny', 'ls', 'denied'],
    ['read_only', 'ask', 'ls', 'user-approval'],
    ['read_only', 'allow', 'rm -rf x', 'approved'],
    ['editing', undefined, 'ls', 'approved'],
    ['editing', undefined, 'rm -rf x', 'user-approval'],
    ['editing', 'deny', 'ls', 'denied'],
    ['editing', 'ask', 'ls', 'user-approval'],
    ['editing', 'allow', 'rm -rf x', 'approved'],
    ['god', undefined, 'ls', 'approved'],
    ['god', undefined, 'rm -rf x', 'user-approval'],
    ['god', 'deny', 'ls', 'denied'],
    ['god', 'ask', 'rm -rf x', 'user-approval'],
    ['god', 'allow', 'rm -rf x', 'approved'],
  ]

  it.each(rows)('%s with persisted %s: %s -> %s', async (mode, persisted, command, expected) => {
    expect((await decide(mode, command, persisted)).type).toBe(expected)
  })

  it('names the sensitive reason next to the prompt', async () => {
    expect(await decide('god', 'rm -rf x')).toEqual({ type: 'user-approval', reason: 'Sensitive: recursive delete' })
  })
})

describe('failing closed', () => {
  it('denies when the bridge is disconnected, even with a persisted allow', async () => {
    const p = createFakePort({ bind: { ok: false, code: 'unavailable', message: 'not connected' } })
    const result = await decide('god', 'ls', 'allow', p)
    expect(result).toEqual({ type: 'denied', reason: 'Terminal unavailable: not connected' })
    expect(p.classified).toEqual([])
  })

  it('denies when the bridge runs in another folder', async () => {
    const p = createFakePort({ bind: { ok: false, code: 'root_mismatch', message: 'different folder' } })
    expect((await decide('editing', 'ls', undefined, p)).type).toBe('denied')
  })

  it('denies when binding hangs past the timeout', { timeout: 10000 }, async () => {
    const p = createFakePort({ bind: () => new Promise(() => {}) })
    expect(await decide('god', 'ls', undefined, p)).toMatchObject({ type: 'denied' })
  })

  it('asks when classification fails, rather than running an unclassified command', async () => {
    const p = createFakePort({
      classify: () => {
        throw new Error('timeout')
      },
    })
    expect(await decide('god', 'ls', undefined, p)).toEqual({ type: 'user-approval', reason: 'Could not classify command' })
  })

  it('denies terminal_write to a session another thread or the user owns', async () => {
    const p = createFakePort({
      sessions: [
        fakeSession('00000000-0000-4000-8000-000000000001', { source: 'model', threadId: 'other' }),
        fakeSession('00000000-0000-4000-8000-000000000002', { source: 'user' }),
      ],
    })
    for (const session of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'nope']) {
      const result = await commandApprovalFor(
        p,
        { threadId: 't1', mode: 'god', settings: { tools: {} } },
        'terminal_write',
        { session, input: 'y' },
        'c1',
      )
      expect(result.type).toBe('denied')
    }
  })

  it('classifies terminal_write input in the bridge for an owned session', async () => {
    const session = '00000000-0000-4000-8000-000000000003'
    const p = createFakePort({
      sessions: [fakeSession(session, { source: 'agent', threadId: 't1', runId: 'r1' })],
      classifyInput: (_s, input) => (input === 'f ~' ? SENSITIVE : SAFE),
    })
    const ctx = { threadId: 't1', mode: 'god' as const, settings: { tools: {} } }
    expect((await commandApprovalFor(p, ctx, 'terminal_write', { session, input: 'y' }, 'a')).type).toBe('approved')
    expect((await commandApprovalFor(p, ctx, 'terminal_write', { session, input: 'f ~' }, 'b')).type).toBe(
      'user-approval',
    )
  })

  it('does not classify terminal_start without a command, since each submitted line is checked later', async () => {
    const p = port()
    const result = await commandApprovalFor(
      p,
      { threadId: 't1', mode: 'editing', settings: { tools: {} } },
      'terminal_start',
      {},
      'c',
    )
    expect(result.type).toBe('approved')
    expect(p.classified).toEqual([])
  })
})

describe('approval ledger', () => {
  it('lets execute run only the exact input that was approved', async () => {
    const p = port()
    const ctx = { threadId: 't1', mode: 'god' as const, settings: { tools: {} } }
    await commandApprovalFor(p, ctx, 'run_command', { command: 'ls' }, 'c1')
    expect(consumeApproval(p, 'c1', 'run_command', { command: 'rm -rf /' })).toBe(false)
    await commandApprovalFor(p, ctx, 'run_command', { command: 'ls' }, 'c2')
    expect(consumeApproval(p, 'c2', 'run_command', { command: 'ls' })).toEqual({})
    expect(consumeApproval(p, 'c2', 'run_command', { command: 'ls' })).toBe(false)
  })

  it('pins a terminal_write approval to the session input state the bridge checked', async () => {
    const session = '00000000-0000-4000-8000-000000000009'
    const p = createFakePort({
      sessions: [fakeSession(session, { source: 'model', threadId: 't1' })],
      classifyInput: () => ({ sensitive: false, reasons: [], commands: [], inputVersion: 7 }),
    })
    await commandApprovalFor(p, { threadId: 't1', mode: 'god', settings: { tools: {} } }, 'terminal_write', { session, input: 'y' }, 'w1')
    expect(consumeApproval(p, 'w1', 'terminal_write', { session, input: 'y' })).toEqual({ inputVersion: 7 })
  })

  it('refuses a call approved before the bridge reconnected', async () => {
    const p = port()
    await commandApprovalFor(p, { threadId: 't1', mode: 'god', settings: { tools: {} } }, 'run_command', { command: 'ls' }, 'c1')
    p.setEpoch(2)
    expect(consumeApproval(p, 'c1', 'run_command', { command: 'ls' })).toBe(false)
  })

  it('refuses a call that never went through approval', () => {
    expect(consumeApproval(port(), 'never', 'run_command', { command: 'ls' })).toBe(false)
  })

  it('does not record denied calls', async () => {
    const p = port()
    await commandApprovalFor(p, { threadId: 't1', mode: 'god', settings: { tools: { run_command: 'deny' } } }, 'run_command', { command: 'ls' }, 'c1')
    expect(consumeApproval(p, 'c1', 'run_command', { command: 'ls' })).toBe(false)
  })
})

describe('command lane', () => {
  it('holds a safe command behind an earlier one awaiting approval in the same step', async () => {
    const lane = createCommandLane()
    const first = lane(3, async () => ({ type: 'user-approval', reason: 'Sensitive: recursive delete' }))
    const second = lane(3, async () => ({ type: 'approved' }))
    expect(await first).toMatchObject({ type: 'user-approval' })
    expect(await second).toEqual({ type: 'user-approval', reason: LANE_REASON })
  })

  it('evaluates calls in order even when a later one decides faster', async () => {
    const lane = createCommandLane()
    const slow = lane(1, () => new Promise((resolve) => setTimeout(() => resolve({ type: 'user-approval' }), 30)))
    const fast = lane(1, async () => ({ type: 'approved' }))
    expect((await fast).type).toBe('user-approval')
    expect((await slow).type).toBe('user-approval')
  })

  it('resets on the next step', async () => {
    const lane = createCommandLane()
    await lane(1, async () => ({ type: 'user-approval' }))
    expect(await lane(2, async () => ({ type: 'approved' }))).toEqual({ type: 'approved' })
  })

  it('does not hold a denied call or let it block others', async () => {
    const lane = createCommandLane()
    expect((await lane(1, async () => ({ type: 'denied', reason: 'x' }))).type).toBe('denied')
    expect((await lane(1, async () => ({ type: 'approved' }))).type).toBe('approved')
  })
})

it('describes command inputs for the approval card', () => {
  expect(describeCommandInput('run_command', { command: 'rm -rf dist', cwd: 'web' })).toBe('$ rm -rf dist\n  in web')
  expect(describeCommandInput('terminal_start', {})).toBe('$ (interactive bash shell)')
  expect(
    describeCommandInput('terminal_write', { session: '0f8fad5b-d9cb', input: 'y', keys: ['enter'], submit: false }),
  ).toBe('→ session 0f8fad5b: "y" [enter]')
  expect(describeCommandInput('write_file', {})).toBeNull()
})
