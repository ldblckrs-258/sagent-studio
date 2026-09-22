import { describe, expect, it, vi } from 'vitest'
import { createApprovalQueue } from './approval-queue'
import { AgentRunStore } from './store'
import type { AgentRunRecord } from './store'

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
