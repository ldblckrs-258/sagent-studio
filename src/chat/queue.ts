import { createMessageQueue } from '@assistant-ui/react'
import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  QueueItemState,
} from '@assistant-ui/react'
import type { Attachment } from './attachments'
import type { WorkspaceFs } from '../workspace/fs'
import { extractText } from './convert'
import type { IncomingContent } from './convert'

/**
 * The chips a message carried when it was sent, plus the thread they were
 * captured on. A message can wait in the queue through an entire run, so the
 * driver checks that id before resolving anything against the bound folder.
 */
export interface AttachmentSnapshot {
  threadId: string
  attachments: Attachment[]
  /** The folder the chips were picked from, compared by identity at dispatch. */
  fs: WorkspaceFs | null
}

export interface ChatQueueOptions {
  /** Routes one dispatched message. Slash text and plain text both go here. */
  dispatch(text: string, snapshot?: AttachmentSnapshot): Promise<void>
  /**
   * Reads the composer's chips at send time; called once per enqueue with the
   * message's text, so a route that cannot carry them can decline.
   */
  capture?(text: string): AttachmentSnapshot | undefined
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
  /** Chips captured with a pending item, so a queued row can show its count. */
  attachmentsFor(item: QueueItemState): readonly Attachment[]
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
 * Chips captured with a message, keyed on its first content part rather than
 * the message itself: the runtime re-points a queued message at the tail with a
 * shallow spread, and a queue item projects the same part objects, so the part
 * survives both hops while the message object does not.
 */
const snapshots = new WeakMap<object, AttachmentSnapshot>()

const keyOf = (parts: readonly object[]): object | undefined =>
  parts.length > 0 ? parts[0] : undefined

const snapshotOf = (parts: readonly object[]): AttachmentSnapshot | undefined => {
  const key = keyOf(parts)
  return key === undefined ? undefined : snapshots.get(key)
}

/** What a pending queue item is carrying, for the row that renders it. */
export function attachmentsForQueueParts(
  parts: readonly unknown[],
): readonly Attachment[] {
  return snapshotOf(parts as readonly object[])?.attachments ?? []
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
      const snapshot = snapshotOf(message.content as readonly object[])
      dispatching += 1
      sync()
      void options
        .dispatch(text, snapshot)
        .catch(options.onError)
        .finally(() => {
          dispatching -= 1
          sync()
        })
    },
  })

  const remember = (message: AppendMessage) => {
    const snapshot = options.capture?.(
      extractText(message.content as unknown as IncomingContent),
    )
    if (snapshot === undefined || snapshot.attachments.length === 0) return
    const key = keyOf(message.content as readonly object[])
    if (key !== undefined) snapshots.set(key, snapshot)
  }

  const adapter: ExternalThreadQueueAdapter = {
    get items() {
      return controller.adapter.items
    },
    get steerItems() {
      return controller.adapter.steerItems
    },
    enqueue: (message) => {
      remember(message)
      controller.adapter.enqueue(message)
    },
    steer: (message) => {
      remember(message)
      controller.adapter.steer(message)
    },
    move: (id, placement) => controller.adapter.move(id, placement),
    edit: (id, message) => {
      // Editing a queued message rebuilds its parts, so the snapshot has to
      // move to the new key or the chips — already taken from the composer —
      // would be lost with no way to re-attach them.
      const item = [
        ...controller.adapter.items,
        ...controller.adapter.steerItems,
      ].find((candidate) => candidate.id === id)
      const carried =
        item === undefined ? undefined : snapshotOf(item.parts as readonly object[])
      controller.adapter.edit(id, message)
      const key = keyOf(message.content as readonly object[])
      if (carried !== undefined && key !== undefined) snapshots.set(key, carried)
    },
    remove: (id) => controller.adapter.remove(id),
    __internal_setDispatchTransform: (transform) =>
      controller.adapter.__internal_setDispatchTransform?.(transform),
    __internal_notifyCancelled: () =>
      controller.adapter.__internal_notifyCancelled?.(),
  }

  return {
    adapter,
    attachmentsFor: (item) => attachmentsForQueueParts(item.parts),
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
