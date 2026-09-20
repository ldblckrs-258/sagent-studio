import { createMessageQueue } from '@assistant-ui/react'
import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  QueueItemState,
} from '@assistant-ui/react'
import { extractText } from './convert'
import type { IncomingContent } from './convert'

export interface ChatQueueOptions {
  /** Routes one dispatched message. Slash text and plain text both go here. */
  dispatch(text: string): Promise<void>
  onError(error: unknown): void
  /**
   * In-flight runs this queue did not start — a rerun, an edit, or an approval
   * resume. Without it the queue would dispatch straight into such a run and
   * `startRun` would abort it.
   */
  externalRunCount(): number
}

export interface ChatQueue {
  adapter: ExternalThreadQueueAdapter
  /** Re-reads `externalRunCount` and notifies the queue on a busy/idle edge. */
  sync(): void
  notifyCancelled(): void
  /** Drops pending items and settles the busy flag. */
  reset(): void
  /**
   * Fires whenever the lanes change. The external-store runtime does not
   * subscribe to the queue (only the local runtime does), so without this a
   * removed item stays on screen until something unrelated repaints.
   */
  subscribe(listener: () => void): () => void
  pendingItems(): readonly QueueItemState[]
}

/**
 * The queue that keeps the composer usable during a run.
 *
 * Busy is tracked from two sources at once, and the library is notified only on
 * the edge of their union. One source is the store's run count, for runs
 * started elsewhere. The other is this queue's own dispatch, which matters
 * because not every dispatch starts a run: `/compact` and a bare `/<skill-id>`
 * complete without ever touching the run count, and a queue that waited on the
 * store alone would stay "running" forever after one of them — every later
 * message would queue and none would ever dispatch.
 *
 * The driver deliberately has no `cancel`. With one, the library's steer lane
 * aborts the running turn and dispatches the new message at once; without one,
 * "steering degrades to process next", which is the behavior wanted here: a
 * message typed during a run waits its turn and the run is left alone. The
 * consequence is that a pending item cannot be promoted to run immediately.
 *
 * `run` returns synchronously because the library reads a synchronous throw as
 * a run that never started and restores the message. A rejection from
 * `dispatch` is therefore reported rather than thrown, since by then the work
 * has begun and restoring the item would send it twice.
 */
export function createChatQueue(options: ChatQueueOptions): ChatQueue {
  let dispatching = 0
  let busy = false

  const sync = () => {
    const active = dispatching > 0 || options.externalRunCount() > 0
    if (active && !busy) {
      controller.notifyBusy()
      busy = true
    } else if (!active && busy) {
      controller.notifyIdle()
      busy = false
    }
  }

  const controller = createMessageQueue({
    run: (message: AppendMessage) => {
      const text = extractText(message.content as unknown as IncomingContent)
      dispatching += 1
      sync()
      void options
        .dispatch(text)
        .catch(options.onError)
        .finally(() => {
          dispatching -= 1
          sync()
        })
    },
  })

  return {
    adapter: controller.adapter,
    sync,
    notifyCancelled: () => controller.notifyCancelled(),
    subscribe: (listener) => controller.subscribe(listener),
    reset: () => {
      controller.clear()
      if (busy) {
        controller.notifyIdle()
        busy = false
      }
    },
    pendingItems: () => [
      ...controller.adapter.steerItems,
      ...controller.adapter.items,
    ],
  }
}
