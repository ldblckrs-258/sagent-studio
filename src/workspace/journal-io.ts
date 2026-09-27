import type { WorkspaceApi } from '../tools/types'
import { RestoreApplyError, WorkspaceLimitError, WorkspaceNotFoundError } from './errors'
import { withPathLock, withWorkspaceLock } from './lock'
import type { JournalKind, RestoreChange, RestoreOutcome, WorkspaceJournal } from './journal'

/**
 * Reads a path for journaling. Returns unknown when the content cannot be
 * captured (size cap, binary), so the caller skips the journal entry instead of
 * recording a bogus "absent" state that a restore would trust.
 */
export async function readForJournal(
  workspace: WorkspaceApi,
  path: string,
): Promise<{ known: boolean; content: string | null }> {
  try {
    return { known: true, content: await workspace.readFile(path) }
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return { known: true, content: null }
    if (error instanceof WorkspaceLimitError) return { known: false, content: null }
    throw error
  }
}

/**
 * Records a mutation in the given conversation's journal. `journal` is optional
 * so a tool can run without one (older call sites, tests); journaling is
 * best-effort and must never fail the mutation.
 */
export function recordMutation(
  journal: WorkspaceJournal | undefined,
  kind: Exclude<JournalKind, 'checkpoint'>,
  path: string,
  before: string | null,
  after: string | null,
  options: { partial?: boolean } = {},
): void {
  if (!journal) return
  try {
    journal.record({
      kind,
      path,
      before,
      after,
      ...(options.partial === true ? { partial: true } : {}),
    })
  } catch {
    // best-effort
  }
}

/**
 * Writes a file the way the workspace tools do: under the path lock and into
 * the conversation journal. The sandbox `fs`/`workspace` bridge uses it so a
 * script write stays visible to checkpoint, restore, diff, and history.
 */
export async function journaledWrite(
  journal: WorkspaceJournal | undefined,
  workspace: WorkspaceApi,
  path: string,
  content: string,
): Promise<void> {
  await withPathLock(path, async () => {
    const before = await readForJournal(workspace, path)
    await workspace.writeFile(path, content)
    if (before.known) recordMutation(journal, 'write', path, before.content, content)
  })
}

export async function applyRestore(
  journal: WorkspaceJournal,
  workspace: WorkspaceApi,
  changes: RestoreChange[],
  options: { checkConflicts?: boolean } = {},
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { restored: [], removed: [], skipped: [], conflicts: [] }
  await withWorkspaceLock(async () => {
    for (const change of changes) {
      try {
        const current = await readForJournal(workspace, change.path)
        if (!current.known) {
          outcome.skipped.push(change.path)
          continue
        }
        if (current.content === change.content) continue
        if (options.checkConflicts === true && current.content !== change.expected) {
          outcome.conflicts.push(change.path)
          continue
        }
        if (change.content === null) {
          await workspace.remove(change.path)
          outcome.removed.push(change.path)
        } else {
          await workspace.writeFile(change.path, change.content)
          outcome.restored.push(change.path)
        }
        journal.record({
          kind: 'restore',
          path: change.path,
          before: current.content,
          after: change.content,
        })
      } catch (error) {
        throw new RestoreApplyError(change.path, outcome, { cause: error })
      }
    }
  })
  return outcome
}
