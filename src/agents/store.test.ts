import { describe, expect, it, vi } from 'vitest'
import type { AgentStopReason } from '../chat/types'
import { createApprovalQueue } from './approval-queue'
import { AgentRunStore } from './store'
import type { AgentRunRecord } from './store'
import type { AgentSteeringControl } from './types'

function steeringControl() {
  const pending: string[] = []
  let reason: AgentStopReason | undefined
  const control: AgentSteeringControl = {
    drain: () => pending.splice(0, pending.length),
    enqueue: (text) => {
      pending.push(text)
    },
    stopRequested: () => reason !== undefined,
    stopReason: () => reason,
    requestStop: (next) => {
      reason = next
    },
  }
  return { control, drain: () => control.drain() }
}

const base: AgentRunRecord = {
  runId: 'run-1',
  parentThreadId: 'parent-1',
  mode: 'editing',
  tier: 'medium',
  status: 'running',
  prompt: 'do it',
  events: [],
  text: '',
  toolCalls: 0,
  approvals: [],
  startedAt: 1,
}

describe('AgentRunStore', () => {
  it('bumps its version on every mutation and notifies subscribers', () => {
    const store = new AgentRunStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const start = store.getVersion()
    store.register(base)
    store.appendEvent('run-1', { type: 'text-delta', text: 'hi' })
    store.finish('run-1', { status: 'completed', mode: 'editing', tier: 'medium', text: 'hi', toolCalls: 0 })
    expect(store.getVersion()).toBeGreaterThan(start)
    expect(listener).toHaveBeenCalled()
    expect(store.get('run-1')?.text).toBe('hi')
    expect(store.get('run-1')?.status).toBe('completed')
  })

  it('filters by parent thread and sorts newest first', () => {
    const store = new AgentRunStore()
    store.register({ ...base, runId: 'a', startedAt: 1 })
    store.register({ ...base, runId: 'b', startedAt: 2 })
    store.register({ ...base, runId: 'c', parentThreadId: 'parent-2', startedAt: 3 })
    expect(store.list('parent-1').map((run) => run.runId)).toEqual(['b', 'a'])
    expect(store.list()).toHaveLength(3)
  })

  it('counts and clears on clear', () => {
    const store = new AgentRunStore()
    store.register(base)
    store.addApproval('run-1', { id: 'ap1', runId: 'run-1', toolName: 'remove', input: {}, createdAt: 1 })
    expect(store.pendingApprovalCount()).toBe(1)
    expect(store.pendingApprovalCount('parent-1')).toBe(1)
    expect(store.pendingApprovalCount('other')).toBe(0)
    store.clear()
    expect(store.list()).toEqual([])
    expect(store.pendingApprovalCount()).toBe(0)
  })

  it('enqueues a steering message in order for a running run', () => {
    const store = new AgentRunStore()
    store.register(base)
    const steering = steeringControl()
    store.attachSteering('run-1', steering.control)

    expect(store.steer('run-1', 'first')).toBe(true)
    expect(store.steer('run-1', 'second')).toBe(true)

    expect(store.get('run-1')?.events).toEqual([])
    expect(steering.drain()).toEqual(['first', 'second'])
  })

  it('refuses to steer a run that is not live', () => {
    const store = new AgentRunStore()
    store.register({ ...base, status: 'completed' })
    const steering = steeringControl()
    store.attachSteering('run-1', steering.control)

    expect(store.steer('run-1', 'too late')).toBe(false)
    expect(steering.drain()).toEqual([])
  })

  it('refuses a steer once the channel is closed', () => {
    const store = new AgentRunStore()
    store.register(base)
    let closed = false
    const enqueue = vi.fn()
    const control: AgentSteeringControl = {
      drain: () => [],
      enqueue,
      stopRequested: () => false,
      stopReason: () => undefined,
      requestStop: () => {},
      accepting: () => !closed,
      close: () => {
        closed = true
      },
    }
    store.attachSteering('run-1', control)

    expect(store.steer('run-1', 'still going')).toBe(true)
    control.close?.()
    expect(store.steer('run-1', 'too late')).toBe(false)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('retains a stop reason and drops steering state on remove and clear', () => {
    const store = new AgentRunStore()
    store.register(base)
    const steering = steeringControl()
    store.attachSteering('run-1', steering.control)

    expect(store.requestStop('run-1', 'user_stop')).toBe(true)
    expect(store.stopRequested('run-1')).toBe(true)
    expect(steering.control.stopReason()).toBe('user_stop')

    store.remove('run-1')
    expect(store.stopRequested('run-1')).toBe(false)

    store.register(base)
    store.attachSteering('run-1', steering.control)
    store.clear()
    expect(store.stopRequested('run-1')).toBe(false)
  })

  it('keeps the runner-provided stopped status and reason on finish', () => {
    const store = new AgentRunStore()
    store.register(base)
    store.finish('run-1', {
      status: 'stopped',
      mode: 'editing',
      tier: 'medium',
      text: 'x',
      toolCalls: 0,
      stopReason: 'user_stop',
    })
    expect(store.get('run-1')?.status).toBe('stopped')
    expect(store.get('run-1')?.stopReason).toBe('user_stop')
  })

  it('routes a resolution to the owning queue and removes the card', async () => {
    const controller = new AbortController()
    const store = new AgentRunStore()
    store.register(base)
    const queue = createApprovalQueue({ signal: controller.signal })
    store.attachQueue('run-1', queue)
    const decision = queue.request({ runId: 'run-1', toolName: 'remove', input: {} })
    const [entry] = queue.pending()
    store.addApproval('run-1', entry)

    store.resolveApproval(entry.id, true)
    await expect(decision).resolves.toBe(true)
    expect(store.pendingApprovalCount()).toBe(0)
  })
})
