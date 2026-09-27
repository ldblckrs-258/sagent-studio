import type { WorkspaceApi } from '../tools/types'
import type { WorkspaceJournal } from './journal'
import { readForJournal } from './journal-io'
import { withWorkspaceLock } from './lock'

export interface RunRevertOutcome {
  reverted: string[]
  conflicts: string[]
  unrestorable: string[]
  expired?: boolean
}

export function tagJournal(journal: WorkspaceJournal, runId: string): WorkspaceJournal {
  return {
    ...journal,
    record: (input) => journal.record({ ...input, runId }),
  }
}

export async function applyRunRevert(
  workspace: WorkspaceApi,
  journal: WorkspaceJournal,
  runId: string,
  label: string,
): Promise<RunRevertOutcome> {
  const plan = journal.planRunRevert(runId)
  if (plan.expired) return { reverted: [], conflicts: [], unrestorable: [], expired: true }
  const reverted: string[] = []
  const conflicts = [...plan.conflicts]
  await withWorkspaceLock(async () => {
    for (const change of plan.changes) {
      const current = await readForJournal(workspace, change.path)
      if (!current.known || current.content !== change.expected) {
        conflicts.push(change.path)
        continue
      }
      if (change.content === null) await workspace.remove(change.path)
      else await workspace.writeFile(change.path, change.content)
      journal.record({
        kind: 'restore',
        path: change.path,
        before: current.content,
        after: change.content,
        label: `revert run ${label}`,
      })
      reverted.push(change.path)
    }
  })
  return { reverted, conflicts, unrestorable: plan.unrestorable }
}
