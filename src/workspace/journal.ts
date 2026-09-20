import { splitLines } from './lines'
import { contentHash } from './revision'

/**
 * A bounded, in-memory write journal for workspace text mutations. It supports
 * checkpoints (named restore points), per-path history, and a diff against a
 * prior state. It is intentionally process-local: it survives edits within a
 * session, not a page reload.
 *
 * It records mutations made through the workspace tools (`write_file`,
 * `edit_file`, `remove`, `move`, `copy`, and `restore`) and through the sandbox
 * `fs`/`workspace` bridge, which writes via the same journaled path. A
 * directory transfer is recorded as a partial entry, so restore reports it as
 * unrestorable instead of silently leaving it in place.
 */
export type JournalKind = 'write' | 'edit' | 'remove' | 'restore' | 'checkpoint'

export interface JournalEntry {
  seq: number
  time: number
  kind: JournalKind
  path: string
  before: string | null
  after: string | null
  label?: string
  /** True when a content snapshot was too large to keep; restore must skip it. */
  partial?: boolean
}

export interface JournalCheckpoint {
  id: string
  seq: number
  time: number
  label?: string
}

export interface RestoreChange {
  path: string
  content: string | null
}

export interface RestorePlan {
  checkpoint: JournalCheckpoint
  changes: RestoreChange[]
  unrestorable: string[]
  /** True when the checkpoint predates the retained journal window. */
  expired?: boolean
}

export interface DiffResult {
  changed: boolean
  addedLines: number
  removedLines: number
  text: string
  truncated: boolean
}

export interface HistoryEntry {
  seq: number
  time: number
  kind: JournalKind
  path: string
  label?: string
  beforeHash: string | null
  afterHash: string | null
  partial: boolean
}

const MAX_ENTRIES = 500
const MAX_SNAPSHOT_CHARS = 262_144
const MAX_DIFF_LINES = 400

export interface WorkspaceJournal {
  record(input: {
    kind: Exclude<JournalKind, 'checkpoint'>
    path: string
    before: string | null
    after: string | null
    label?: string
    /** Marks a change whose content was never captured, so restore must skip it. */
    partial?: boolean
  }): JournalEntry
  checkpoint(label?: string): JournalCheckpoint
  planRestore(id: string): RestorePlan | null
  baseContentFor(path: string, since?: string): string | null | undefined
  diff(before: string | null, after: string | null): DiffResult
  history(path?: string, limit?: number): HistoryEntry[]
  checkpoints(limit?: number): JournalCheckpoint[]
  size(): number
  clear(): void
}

function snapshot(value: string | null): { value: string | null; partial: boolean } {
  if (value === null) return { value: null, partial: false }
  if (value.length > MAX_SNAPSHOT_CHARS) return { value: null, partial: true }
  return { value, partial: false }
}

function diffLines(before: string | null, after: string | null): DiffResult {
  const beforeLines = before === null ? [] : splitLines(before)
  const afterLines = after === null ? [] : splitLines(after)

  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = beforeLines.slice(prefix, beforeLines.length - suffix)
  const added = afterLines.slice(prefix, afterLines.length - suffix)
  if (removed.length === 0 && added.length === 0) {
    return { changed: false, addedLines: 0, removedLines: 0, text: '', truncated: false }
  }

  const body = [
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ]
  const truncated = body.length > MAX_DIFF_LINES
  const shown = truncated ? body.slice(0, MAX_DIFF_LINES) : body
  const start = prefix + 1
  const header = `@@ -${start},${removed.length} +${start},${added.length} @@`
  return {
    changed: true,
    addedLines: added.length,
    removedLines: removed.length,
    text: [header, ...shown].join('\n'),
    truncated,
  }
}

export function createWorkspaceJournal(): WorkspaceJournal {
  let seq = 0
  let entries: JournalEntry[] = []
  const checkpoints = new Map<string, JournalCheckpoint>()

  const push = (entry: JournalEntry): void => {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES)
  }

  const contentEntries = (path?: string): JournalEntry[] =>
    entries.filter(
      (entry) => entry.kind !== 'checkpoint' && (path === undefined || entry.path === path),
    )

  const oldestSeq = (): number => entries[0]?.seq ?? 0

  const lastBeforeMarker = (path: string, markerSeq: number): JournalEntry | undefined => {
    let found: JournalEntry | undefined
    for (const entry of entries) {
      if (entry.kind === 'checkpoint' || entry.path !== path || entry.seq > markerSeq) continue
      found = entry
    }
    return found
  }

  const earliestAfterMarker = (path: string, markerSeq: number): JournalEntry | undefined => {
    for (const entry of entries) {
      if (entry.kind === 'checkpoint' || entry.path !== path || entry.seq <= markerSeq) continue
      return entry
    }
    return undefined
  }

  return {
    record(input) {
      const before = snapshot(input.before)
      const after = snapshot(input.after)
      seq += 1
      const entry: JournalEntry = {
        seq,
        time: Date.now(),
        kind: input.kind,
        path: input.path,
        before: before.value,
        after: after.value,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(before.partial || after.partial || input.partial === true
          ? { partial: true }
          : {}),
      }
      push(entry)
      return entry
    },

    checkpoint(label) {
      seq += 1
      const checkpoint: JournalCheckpoint = {
        id: `cp-${seq}`,
        seq,
        time: Date.now(),
        ...(label === undefined ? {} : { label }),
      }
      checkpoints.set(checkpoint.id, checkpoint)
      push({
        seq,
        time: checkpoint.time,
        kind: 'checkpoint',
        path: '',
        before: null,
        after: null,
        ...(label === undefined ? {} : { label }),
      })
      return checkpoint
    },

    planRestore(id) {
      const checkpoint = checkpoints.get(id)
      if (!checkpoint) return null
      if (checkpoint.seq < oldestSeq()) {
        return { checkpoint, changes: [], unrestorable: [], expired: true }
      }
      const paths = new Set(contentEntries().map((entry) => entry.path))
      const changes: RestoreChange[] = []
      const unrestorable: string[] = []
      for (const path of paths) {
        const before = lastBeforeMarker(path, checkpoint.seq)
        if (before) {
          if (before.partial) {
            unrestorable.push(path)
            continue
          }
          changes.push({ path, content: before.after })
          continue
        }
        // No change at or before the marker. The earliest retained entry after
        // it carries the pre-checkpoint state in `before`, so restore to that —
        // a null `before` is the only evidence of genuine post-checkpoint
        // creation, which is the only case that may delete a file.
        const after = earliestAfterMarker(path, checkpoint.seq)
        if (!after) continue
        if (after.partial) {
          unrestorable.push(path)
          continue
        }
        changes.push({ path, content: after.before })
      }
      return { checkpoint, changes, unrestorable }
    },

    baseContentFor(path, since) {
      if (since !== undefined) {
        const checkpoint = checkpoints.get(since)
        if (!checkpoint) return undefined
        if (checkpoint.seq < oldestSeq()) return undefined
        const entry = lastBeforeMarker(path, checkpoint.seq)
        if (entry) return entry.partial ? undefined : entry.after
        const after = earliestAfterMarker(path, checkpoint.seq)
        if (!after) return undefined
        return after.partial ? undefined : after.before
      }
      const history = contentEntries(path)
      if (history.length === 0) return undefined
      const last = history[history.length - 1]
      return last.partial ? undefined : last.before
    },

    diff(before, after) {
      return diffLines(before, after)
    },

    history(path, limit = 50) {
      return contentEntries(path)
        .slice(-limit)
        .reverse()
        .map((entry) => ({
          seq: entry.seq,
          time: entry.time,
          kind: entry.kind,
          path: entry.path,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          beforeHash: entry.before === null ? null : contentHash(entry.before),
          afterHash: entry.after === null ? null : contentHash(entry.after),
          partial: entry.partial === true,
        }))
    },

    checkpoints(limit = 50) {
      return [...checkpoints.values()].slice(-limit).reverse()
    },

    size() {
      return entries.length
    },

    clear() {
      seq = 0
      entries = []
      checkpoints.clear()
    },
  }
}

/** The process-wide journal shared by the workspace and history tools. */
export const workspaceJournal = createWorkspaceJournal()
