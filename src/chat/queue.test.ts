import type { AppendMessage } from '@assistant-ui/react'
import { describe, expect, it } from 'vitest'
import type { Attachment } from './attachments'
import { createChatQueue } from './queue'
import type { AttachmentSnapshot, ChatQueue } from './queue'

function message(text: string): AppendMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    parentId: null,
    sourceId: null,
    runConfig: {},
    attachments: [],
  } as unknown as AppendMessage
}

/*
  The harness stands in for the two things the real wiring supplies: the store's
  per-thread run count (`externalRuns`, for runs the queue did not start) and a
  dispatch whose promise spans the run it starts. `settle` is how a test ends a
  dispatch that started a run.
*/
function harness(options: { startsRun?: boolean } = {}) {
  const startsRun = options.startsRun ?? true
  const dispatched: string[] = []
  const errors: unknown[] = []
  const pending: (() => void)[] = []
  let externalRuns = 0
  // Referenced from `dispatch`, which only runs after this binding is set.
  const queue: ChatQueue = createChatQueue({
    dispatch: (text) => {
      dispatched.push(text)
      if (!startsRun) return Promise.resolve()
      externalRuns += 1
      queue.sync()
      return new Promise<void>((resolve) => {
        pending.push(() => {
          externalRuns -= 1
          queue.sync()
          resolve()
        })
      })
    },
    onError: (error) => errors.push(error),
    externalRunCount: () => externalRuns,
  })

  return {
    get queue() {
      return queue
    },
    dispatched,
    errors,
    /** Ends the oldest in-flight dispatch, as a settling run would. */
    settle: async () => {
      pending.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
    },
    /** A run the queue did not start, such as a rerun or an approval resume. */
    beginExternalRun: () => {
      externalRuns += 1
      queue.sync()
    },
    endExternalRun: () => {
      externalRuns -= 1
      queue.sync()
    },
  }
}

describe('createChatQueue', () => {
  it('dispatches immediately while nothing is running', () => {
    const h = harness()

    h.queue.adapter.enqueue(message('first'))

    expect(h.dispatched).toEqual(['first'])
  })

  it('holds a message sent during a run instead of starting a second one', () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))

    h.queue.adapter.steer(message('during the run'))

    expect(h.dispatched).toEqual(['first'])
    expect(h.queue.pendingItems()).toHaveLength(1)
  })

  it('dispatches in order once each run settles', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('second'))
    h.queue.adapter.steer(message('third'))
    expect(h.dispatched).toEqual(['first'])

    await h.settle()
    expect(h.dispatched).toEqual(['first', 'second'])

    await h.settle()
    expect(h.dispatched).toEqual(['first', 'second', 'third'])
  })

  it('holds behind a run the queue did not start, such as a rerun', () => {
    const h = harness()
    h.beginExternalRun()

    h.queue.adapter.steer(message('typed during a rerun'))

    // Dispatching here would make `startRun` abort the rerun in flight.
    expect(h.dispatched).toEqual([])
    expect(h.queue.pendingItems()).toHaveLength(1)
  })

  it('drains once a run it did not start settles', () => {
    const h = harness()
    h.beginExternalRun()
    h.queue.adapter.steer(message('waited'))

    h.endExternalRun()

    expect(h.dispatched).toEqual(['waited'])
  })

  it('keeps draining after a dispatch that starts no run', async () => {
    // `/compact` and a bare `/<skill-id>` complete without a run. A queue that
    // waited on the store's run count alone would stay busy forever here, and
    // every later message would be stranded.
    const h = harness({ startsRun: false })

    h.queue.adapter.enqueue(message('/compact'))
    await Promise.resolve()
    await Promise.resolve()
    h.queue.adapter.enqueue(message('a later question'))
    await Promise.resolve()

    expect(h.dispatched).toEqual(['/compact', 'a later question'])
    expect(h.queue.pendingItems()).toHaveLength(0)
  })

  it('routes a queued slash command through the same dispatch path', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('/compact keep the notes'))

    await h.settle()

    // The queue hands over raw text; `dispatchComposerText` is what decides it
    // is a command, so a queued command and a typed one take one route.
    expect(h.dispatched).toEqual(['first', '/compact keep the notes'])
  })

  it('holds the queue on a cancel rather than draining it', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('after the cancel'))

    h.queue.notifyCancelled()
    await h.settle()

    expect(h.dispatched).toEqual(['first'])
    expect(h.queue.pendingItems()).toHaveLength(1)
  })

  it('resumes draining on the next explicit send after a cancel', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('held'))
    h.queue.notifyCancelled()
    await h.settle()
    expect(h.dispatched).toEqual(['first'])

    h.queue.adapter.enqueue(message('resumed'))

    expect(h.dispatched).toEqual(['first', 'held'])
  })

  it('drops pending items on reset without dispatching them', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('abandoned'))

    h.queue.reset()
    await h.settle()

    expect(h.dispatched).toEqual(['first'])
    expect(h.queue.pendingItems()).toHaveLength(0)
  })

  it('removes a single pending item', async () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('keep'))
    h.queue.adapter.steer(message('drop'))
    const dropId = h.queue.pendingItems()[1].id

    h.queue.adapter.remove(dropId)
    await h.settle()

    expect(h.dispatched).toEqual(['first', 'keep'])
  })

  it('reports a dispatch failure instead of throwing out of the driver', async () => {
    const errors: unknown[] = []
    const queue = createChatQueue({
      dispatch: () => Promise.reject(new Error('send failed')),
      onError: (error) => errors.push(error),
      externalRunCount: () => 0,
    })

    expect(() => queue.adapter.enqueue(message('doomed'))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect((errors[0] as Error).message).toBe('send failed')
    // The item is not restored: the work had already started, so restoring it
    // would send the same message twice.
    expect(queue.pendingItems()).toHaveLength(0)
  })

  it('keeps draining after a dispatch fails', async () => {
    const attempts: string[] = []
    let fail = true
    const queue = createChatQueue({
      dispatch: (text) => {
        attempts.push(text)
        if (fail) {
          fail = false
          return Promise.reject(new Error('send failed'))
        }
        return Promise.resolve()
      },
      onError: () => {},
      externalRunCount: () => 0,
    })

    queue.adapter.enqueue(message('doomed'))
    await Promise.resolve()
    await Promise.resolve()
    queue.adapter.enqueue(message('next'))
    await Promise.resolve()

    expect(attempts).toEqual(['doomed', 'next'])
  })

  it('exposes pending items so the composer can list them', () => {
    const h = harness()
    h.queue.adapter.enqueue(message('first'))
    h.queue.adapter.steer(message('a queued question'))

    const parts = h.queue.pendingItems()[0].parts
    expect(parts.map((part) => (part.type === 'text' ? part.text : ''))).toEqual([
      'a queued question',
    ])
  })
})

describe('attachment snapshots', () => {
  function chip(path: string): Attachment {
    return { id: path, kind: 'file', path, source: 'drag' }
  }

  function snapshotHarness() {
    const seen: (AttachmentSnapshot | undefined)[] = []
    let captured: AttachmentSnapshot | undefined
    const pending: (() => void)[] = []
    let running = 0
    const queue: ChatQueue = createChatQueue({
      capture: (text: string) =>
        text.startsWith('/') ? undefined : captured,
      dispatch: (_text, snapshot) => {
        seen.push(snapshot)
        running += 1
        queue.sync()
        return new Promise<void>((resolve) => {
          pending.push(() => {
            running -= 1
            queue.sync()
            resolve()
          })
        })
      },
      onError: () => undefined,
      externalRunCount: () => running,
    })
    return {
      queue,
      seen,
      set: (snapshot: AttachmentSnapshot | undefined) => {
        captured = snapshot
      },
      settle: async () => {
        pending.shift()?.()
        await Promise.resolve()
        await Promise.resolve()
      },
    }
  }

  it('hands the chips captured at send time to the dispatch', () => {
    const h = snapshotHarness()
    h.set({ threadId: 't1', fs: null, attachments: [chip('a.ts')] })
    h.queue.adapter.enqueue(message('look'))
    expect(h.seen[0]?.attachments.map((item) => item.path)).toEqual(['a.ts'])
  })

  it('keeps a queued message pinned to the chips it was sent with', async () => {
    const h = snapshotHarness()
    h.set({ threadId: 't1', fs: null, attachments: [chip('first.ts')] })
    h.queue.adapter.enqueue(message('first'))

    // Typed during the run: its own chips must travel with it, not the ones the
    // composer happens to hold when the queue finally drains.
    h.set({ threadId: 't1', fs: null, attachments: [chip('second.ts')] })
    h.queue.adapter.enqueue(message('second'))
    h.set(undefined)

    await h.settle()
    expect(h.seen.map((snapshot) => snapshot?.attachments[0]?.path)).toEqual([
      'first.ts',
      'second.ts',
    ])
  })

  it('reports what a pending item is carrying', () => {
    const h = snapshotHarness()
    h.set({ threadId: 't1', fs: null, attachments: [chip('a.ts')] })
    h.queue.adapter.enqueue(message('first'))
    h.set({ threadId: 't1', fs: null, attachments: [chip('b.ts'), chip('c.ts')] })
    h.queue.adapter.enqueue(message('second'))

    const pendingItem = h.queue.pendingItems()[0]
    expect(h.queue.attachmentsFor(pendingItem)).toHaveLength(2)
  })

  it('dispatches without a snapshot when nothing is attached', () => {
    const h = snapshotHarness()
    h.set(undefined)
    h.queue.adapter.enqueue(message('plain'))
    expect(h.seen).toEqual([undefined])
  })

  it('leaves the chips alone for a route that cannot carry them', () => {
    const h = snapshotHarness()
    h.set({ threadId: 't1', fs: null, attachments: [chip('a.ts')] })
    // A slash command runs through the registry rather than `sendTurn`, so
    // capturing would clear the composer's chips and drop them silently.
    h.queue.adapter.enqueue(message('/compact'))
    expect(h.seen).toEqual([undefined])
  })

  it('carries the snapshot through the dispatch transform', () => {
    const h = snapshotHarness()
    // The external-store runtime re-points a queued message at the tail with a
    // shallow spread before dispatching it. The snapshot is keyed on the first
    // content part precisely because that survives the spread; if a future
    // version rebuilds `content`, this test is what catches it.
    h.queue.adapter.__internal_setDispatchTransform?.((message) => ({
      ...message,
      parentId: 'tail',
    }))
    h.set({ threadId: 't1', fs: null, attachments: [chip('a.ts')] })
    h.queue.adapter.enqueue(message('look'))
    expect(h.seen[0]?.attachments.map((item) => item.path)).toEqual(['a.ts'])
  })

  it('keeps the chips when a queued message is edited', async () => {
    const h = snapshotHarness()
    h.set({ threadId: 't1', fs: null, attachments: [chip('first.ts')] })
    h.queue.adapter.enqueue(message('first'))
    h.set({ threadId: 't1', fs: null, attachments: [chip('queued.ts')] })
    h.queue.adapter.enqueue(message('queued'))
    h.set(undefined)

    const pendingItem = h.queue.pendingItems()[0]
    h.queue.adapter.edit(pendingItem.id, message('queued, reworded'))
    // The chips were taken from the composer at enqueue, so losing them here
    // would leave no way to re-attach them.
    expect(h.queue.attachmentsFor(h.queue.pendingItems()[0])).toHaveLength(1)

    await h.settle()
    expect(h.seen[1]?.attachments.map((item) => item.path)).toEqual([
      'queued.ts',
    ])
  })
})
