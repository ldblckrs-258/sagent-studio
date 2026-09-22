import { describe, expect, it } from 'vitest'
import { createApprovalQueue } from './approval-queue'

function queueWithSignal() {
  const controller = new AbortController()
  const queue = createApprovalQueue({ signal: controller.signal })
  return { controller, queue }
}

describe('createApprovalQueue', () => {
  it('queues a request and resolves it with the decision', async () => {
    const { queue } = queueWithSignal()
    const decision = queue.request({ runId: 'r1', toolName: 'remove', input: { path: 'a' } })
    expect(queue.pending()).toHaveLength(1)
    const [entry] = queue.pending()
    expect(entry.toolName).toBe('remove')
    queue.resolve(entry.id, true)
    await expect(decision).resolves.toBe(true)
    expect(queue.pending()).toHaveLength(0)
  })

  it('accounts for each request with a distinct id', () => {
    const { queue } = queueWithSignal()
    void queue.request({ runId: 'r1', toolName: 'remove', input: {} })
    void queue.request({ runId: 'r1', toolName: 'write_file', input: {} })
    const ids = queue.pending().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('settles every pending request as denied when the signal aborts', async () => {
    const { controller, queue } = queueWithSignal()
    const first = queue.request({ runId: 'r1', toolName: 'remove', input: {} })
    const second = queue.request({ runId: 'r1', toolName: 'write_file', input: {} })
    controller.abort()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(queue.pending()).toHaveLength(0)
  })

  it('refuses new requests after abort', async () => {
    const { controller, queue } = queueWithSignal()
    controller.abort()
    await expect(queue.request({ runId: 'r1', toolName: 'remove', input: {} })).resolves.toBe(false)
    expect(queue.pending()).toHaveLength(0)
  })

  it('notifies subscribers and bumps the version on each change', () => {
    const { queue } = queueWithSignal()
    let notifications = 0
    queue.subscribe(() => {
      notifications += 1
    })
    const before = queue.getVersion()
    void queue.request({ runId: 'r1', toolName: 'remove', input: {} })
    expect(queue.getVersion()).toBeGreaterThan(before)
    expect(notifications).toBeGreaterThan(0)
  })
})
