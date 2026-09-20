import type { WorkspaceApi } from '../tools/types'
import { WorkspaceLimitError, WorkspaceNotFoundError } from './errors'
import { workspaceJournal } from './journal'
import type { JournalKind } from './journal'
import { withPathLock } from './lock'

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

export function recordMutation(
  kind: Exclude<JournalKind, 'checkpoint'>,
  path: string,
  before: string | null,
  after: string | null,
  options: { partial?: boolean } = {},
): void {
  try {
    workspaceJournal.record({
      kind,
      path,
      before,
      after,
      ...(options.partial === true ? { partial: true } : {}),
    })
  } catch {
    // Journaling is best-effort: a failed record must never fail the mutation.
  }
}

/**
 * Writes a file the way the workspace tools do: under the path lock and into
 * the write journal. The sandbox `fs`/`workspace` bridge uses it so a script
 * write stays visible to checkpoint, restore, diff, and history.
 */
export async function journaledWrite(
  workspace: WorkspaceApi,
  path: string,
  content: string,
): Promise<void> {
  await withPathLock(path, async () => {
    const before = await readForJournal(workspace, path)
    await workspace.writeFile(path, content)
    if (before.known) recordMutation('write', path, before.content, content)
  })
}
