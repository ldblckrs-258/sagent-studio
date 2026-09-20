import { db } from '../vault/db'
import { VaultLockedError } from '../vault/errors'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { createWorkspaceJournal } from './journal'
import type { WorkspaceJournal } from './journal'
import { decodeJournal, encodeJournal } from './journal-codec'

/**
 * Owns one `WorkspaceJournal` per conversation and persists it, encrypted, in
 * the vault database so checkpoints survive a reload. It lives for the whole
 * app session (like the vault `db`), which lets the conversation-delete path
 * drop a thread's journal without threading a store instance through the UI.
 *
 * Writes are debounced: the in-memory journal stays authoritative during a run
 * and a burst of edits becomes one encrypted save.
 */
const SAVE_DEBOUNCE_MS = 400

interface JournalSlot {
  journal: WorkspaceJournal
  dirty: boolean
  saving: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface JournalStore {
  /** Returns the conversation's journal, loading it from the vault on first use. */
  forThread(threadId: string): Promise<WorkspaceJournal>
  /** The already-loaded journal, or undefined. Never triggers a load. */
  peek(threadId: string): WorkspaceJournal | undefined
  flush(threadId: string): Promise<void>
  flushAll(): Promise<void>
  /** Drops the in-memory journal and deletes its persisted row. */
  remove(threadId: string): Promise<void>
  clearAll(): Promise<void>
}

function aad(threadId: string): string {
  return `journal:${threadId}`
}

export function createJournalStore(): JournalStore {
  const slots = new Map<string, JournalSlot>()
  const loads = new Map<string, Promise<WorkspaceJournal>>()

  const persist = async (threadId: string): Promise<void> => {
    const slot = slots.get(threadId)
    if (!slot) return
    if (slot.saving) {
      slot.dirty = true
      await slot.saving
      return
    }
    slot.dirty = false
    slot.saving = (async () => {
      try {
        const encoded = await encodeJournal(slot.journal.snapshotState())
        await vaultWriteQueue.enqueue(async () => {
          const blob = await encryptRecord(encoded, aad(threadId))
          await db.journals.put({ id: threadId, blob, updatedAt: Date.now() })
        })
      } catch (error) {
        // A locked vault cannot persist; the in-memory journal stays usable and
        // the next unlocked write re-saves the whole snapshot.
        if (!(error instanceof VaultLockedError)) throw error
      } finally {
        slot.saving = null
      }
    })()
    await slot.saving
    if (slot.dirty) await persist(threadId)
  }

  const schedule = (threadId: string): void => {
    const slot = slots.get(threadId)
    if (!slot) return
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      slot.timer = undefined
      void persist(threadId)
    }, SAVE_DEBOUNCE_MS)
  }

  const wrap = (threadId: string, journal: WorkspaceJournal): WorkspaceJournal => ({
    ...journal,
    record: (input) => {
      const entry = journal.record(input)
      schedule(threadId)
      return entry
    },
    checkpoint: (label) => {
      const checkpoint = journal.checkpoint(label)
      schedule(threadId)
      return checkpoint
    },
    restoreState: (state) => {
      journal.restoreState(state)
      schedule(threadId)
    },
  })

  const flush = async (threadId: string): Promise<void> => {
    const slot = slots.get(threadId)
    if (!slot) return
    if (slot.timer) {
      clearTimeout(slot.timer)
      slot.timer = undefined
    }
    await persist(threadId)
  }

  const load = async (threadId: string): Promise<WorkspaceJournal> => {    const base = createWorkspaceJournal()
    try {
      const row = await db.journals.get(threadId)
      if (row) {
        const snapshot = await decodeJournal(await decryptRecord(row.blob, aad(threadId)))
        if (snapshot) base.restoreState(snapshot)
      }
    } catch (error) {
      if (!(error instanceof VaultLockedError)) throw error
    }
    const journal = wrap(threadId, base)
    slots.set(threadId, { journal, dirty: false, saving: null, timer: undefined })
    loads.delete(threadId)
    return journal
  }

  return {
    forThread(threadId) {
      const slot = slots.get(threadId)
      if (slot) return Promise.resolve(slot.journal)
      const pending = loads.get(threadId)
      if (pending) return pending
      const promise = load(threadId)
      loads.set(threadId, promise)
      return promise
    },

    peek(threadId) {
      return slots.get(threadId)?.journal
    },

    async flush(threadId) {
      await flush(threadId)
    },

    async flushAll() {
      await Promise.all([...slots.keys()].map((threadId) => flush(threadId)))
    },

    async remove(threadId) {
      const slot = slots.get(threadId)
      if (slot?.timer) clearTimeout(slot.timer)
      slots.delete(threadId)
      loads.delete(threadId)
      await vaultWriteQueue.enqueue(async () => {
        await db.journals.delete(threadId)
      })
    },

    async clearAll() {
      for (const slot of slots.values()) if (slot.timer) clearTimeout(slot.timer)
      slots.clear()
      loads.clear()
      await vaultWriteQueue.enqueue(async () => {
        await db.journals.clear()
      })
    },
  }
}

/** The process-wide journal store shared by the engine and the conversation UI. */
export const workspaceJournalStore = createJournalStore()
