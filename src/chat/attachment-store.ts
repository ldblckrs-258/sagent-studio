import { create } from 'zustand'
import type { Attachment } from './attachments'
import { isDenied } from './attachments'
import type { FileTarget } from '../session/file-view-state'
import { useFileViewStore } from '../session/file-view-state'
import { useChatStore } from './store'

export interface AttachmentState {
  /** Chips per thread. The workspace is bound per thread, so a global list
   * would resolve one conversation's path against another's folder. */
  items: Record<string, Attachment[]>
  /** Threads whose auto chip the user dismissed. */
  autoDisabled: Record<string, true>
  /**
   * Which thread the File panel's current target was opened from. The panel
   * itself is global while the workspace folder is per thread, so without this
   * an auto chip would follow the user into another conversation and resolve
   * its path against a different folder.
   */
  autoOwner: { threadId: string; path: string } | null
  claimAutoTarget(threadId: string, path: string | null): void
  add(threadId: string, attachment: Omit<Attachment, 'id'> & { id?: string }): void
  remove(threadId: string, id: string): void
  /** Returns the manual chips and clears them in one step. */
  take(threadId: string): Attachment[]
  disableAuto(threadId: string): void
  clearThread(threadId: string): void
  /** Moves the pre-thread composer's chips onto the thread its first send made. */
  adoptComposerThread(threadId: string): void
}

let counter = 0

function nextId(path: string): string {
  counter += 1
  return `${path}#${counter}`
}

export const useAttachmentStore = create<AttachmentState>((set, get) => ({
  items: {},
  autoDisabled: {},
  autoOwner: null,

  claimAutoTarget: (threadId, path) =>
    set({ autoOwner: path === null ? null : { threadId, path } }),

  add: (threadId, attachment) =>
    set((state) => {
      const current = state.items[threadId] ?? []
      // First source wins, so a dragged file is not relabelled by a later
      // mention of the same path.
      if (current.some((item) => item.path === attachment.path)) return state
      const next: Attachment = {
        ...attachment,
        id: attachment.id ?? nextId(attachment.path),
      }
      return { items: { ...state.items, [threadId]: [...current, next] } }
    }),

  remove: (threadId, id) =>
    set((state) => {
      const current = state.items[threadId]
      if (!current) return state
      return {
        items: {
          ...state.items,
          [threadId]: current.filter((item) => item.id !== id),
        },
      }
    }),

  take: (threadId) => {
    const current = get().items[threadId] ?? []
    if (current.length > 0) {
      set((state) => ({ items: { ...state.items, [threadId]: [] } }))
    }
    return current
  },

  disableAuto: (threadId) =>
    set((state) => ({ autoDisabled: { ...state.autoDisabled, [threadId]: true } })),

  clearThread: (threadId) =>
    set((state) => {
      const items = { ...state.items }
      delete items[threadId]
      const autoDisabled = { ...state.autoDisabled }
      delete autoDisabled[threadId]
      const autoOwner =
        state.autoOwner?.threadId === threadId ? null : state.autoOwner
      return { items, autoDisabled, autoOwner }
    }),

  adoptComposerThread: (threadId) =>
    set((state) => {
      const pending = state.items['']
      const items = { ...state.items }
      delete items['']
      if (pending && pending.length > 0) {
        items[threadId] = [...(items[threadId] ?? []), ...pending]
      }
      const autoDisabled = { ...state.autoDisabled }
      if (autoDisabled['']) {
        delete autoDisabled['']
        autoDisabled[threadId] = true
      }
      const autoOwner =
        state.autoOwner?.threadId === ''
          ? { ...state.autoOwner, threadId }
          : state.autoOwner
      return { items, autoDisabled, autoOwner }
    }),
}))

/**
 * The key a composer's chips live under. A session's first send happens before
 * a thread exists, so those chips are held under the empty key and adopted by
 * the thread the send creates.
 */
export function composerThreadKey(): string {
  return useChatStore.getState().activeThreadId ?? ''
}

/**
 * The chip that follows the File panel.
 *
 * It follows only what the **user** opened: `authored` holds the paths the
 * model presented through `open_preview`, and including those would let model
 * output — or any file the model is talked into previewing — ride into the next
 * user turn. A deny-listed path never becomes a chip at all.
 */
export function autoAttachmentFor(
  target: FileTarget | null,
  authored: ReadonlySet<string>,
): Attachment | null {
  if (target === null || target.kind !== 'workspace') return null
  if (authored.has(target.path)) return null
  if (isDenied(target.path)) return null
  return {
    id: `auto:${target.path}`,
    kind: 'file',
    path: target.path,
    source: 'auto',
  }
}

/**
 * The auto chip for a thread: only when the user opened the file *from this
 * conversation* and has not dismissed it.
 */
export function autoAttachmentForThread(threadId: string): Attachment | null {
  const { autoDisabled, autoOwner } = useAttachmentStore.getState()
  if (autoDisabled[threadId]) return null
  const { target, authored } = useFileViewStore.getState()
  if (target === null || target.kind !== 'workspace') return null
  if (autoOwner === null) return null
  if (autoOwner.path !== target.path) return null
  // The empty key is the pre-thread composer, adopted by the thread its first
  // send creates.
  if (autoOwner.threadId !== threadId && autoOwner.threadId !== '') return null
  return autoAttachmentFor(target, authored)
}

/**
 * Records which conversation opened the file the File panel is showing. A
 * model-initiated preview is not a user open, so `authored` still decides
 * whether the chip appears at all.
 */
export function subscribeAutoTargetOwner(): () => void {
  let previousPath: string | null = null
  return useFileViewStore.subscribe((state) => {
    const path =
      state.target !== null && state.target.kind === 'workspace'
        ? state.target.path
        : null
    if (path === previousPath) return
    previousPath = path
    useAttachmentStore.getState().claimAutoTarget(composerThreadKey(), path)
  })
}

/**
 * Drops a thread's chips when the conversation really changes. Mirrors the
 * queue's own reset: the first send of a session moves `activeThreadId` from
 * null to a new id, which is not a switch.
 */
export function subscribeAttachmentThreadChanges(): () => void {
  let previous = useChatStore.getState().activeThreadId
  return useChatStore.subscribe((state) => {
    const next = state.activeThreadId
    if (next === previous) return
    const left = previous
    previous = next
    if (left === null) {
      // Not a switch: the session's first send moves the id from null to the
      // thread it just created, which inherits the composer's chips.
      if (next !== null) useAttachmentStore.getState().adoptComposerThread(next)
      return
    }
    useAttachmentStore.getState().clearThread(left)
  })
}
