import { jsonSchema, tool } from 'ai'
import { workspaceJournal } from '../../workspace/journal'
import type { WorkspaceJournal } from '../../workspace/journal'
import { readForJournal } from '../../workspace/journal-io'
import { withPathLock, withWorkspaceLock } from '../../workspace/lock'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['checkpoint', 'restore', 'diff', 'history'] as const

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(input: unknown, key: string): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Workspace history tools backed by the conversation's write journal:
 * `checkpoint` marks a restore point, `restore` reverts to it, `diff` shows a
 * change, and `history` lists recent mutations. The journal comes from the run's
 * ports (one per conversation, persisted across reloads); the module singleton
 * is only a fallback for callers that do not supply one.
 */
export function createHistoryToolProvider(
  fallback: WorkspaceJournal = workspaceJournal,
): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.workspace !== undefined,
    create(name, ports) {
      const workspace = ports.workspace
      const journal = ports.journal ?? fallback
      switch (name) {
        case 'checkpoint':
          return tool({
            description:
              'Record a restore point for the workspace write journal. Returns an id you can pass to restore. Checkpoint before a risky batch of edits.',
            inputSchema: jsonSchema<{ label?: string }>({
              type: 'object',
              properties: { label: { type: 'string' } },
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const checkpoint = journal.checkpoint(readString(input, 'label'))
              return toolOk({
                id: checkpoint.id,
                label: checkpoint.label ?? null,
                time: checkpoint.time,
                entries: journal.size(),
              })
            }),
          })
        case 'restore':
          return tool({
            description:
              'Restore the workspace to a checkpoint made with the checkpoint tool. Reverts every journaled file change recorded after that checkpoint.',
            inputSchema: jsonSchema<{ id: string }>({
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              if (!workspace) throw new ToolRuntimeUnavailableError(name)
              const id = readString(input, 'id') ?? ''
              if (id.length === 0) return toolFail('invalid_input', 'id must be a checkpoint id.')
              const plan = journal.planRestore(id)
              if (!plan) {
                return toolFail('not_found', `No checkpoint has id "${id}".`, {
                  hint: 'Pass the id returned by checkpoint, not its label. Checkpoints are process-local, so ids from before an app reload no longer resolve; call checkpoint again.',
                })
              }
              if (plan.expired) {
                return toolFail(
                  'not_found',
                  `Checkpoint "${id}" is older than the retained journal window, so it cannot be restored safely.`,
                  { hint: 'Create a fresh checkpoint before making further changes.' },
                )
              }
              const restored: string[] = []
              const removed: string[] = []
              const skipped: string[] = []
              await withWorkspaceLock(async () => {
                for (const change of plan.changes) {
                  const current = await readForJournal(workspace, change.path)
                  if (!current.known) {
                    skipped.push(change.path)
                    continue
                  }
                  if (current.content === change.content) continue
                  if (change.content === null) {
                    await workspace.remove(change.path)
                    removed.push(change.path)
                  } else {
                    await workspace.writeFile(change.path, change.content)
                    restored.push(change.path)
                  }
                  journal.record({
                    kind: 'restore',
                    path: change.path,
                    before: current.content,
                    after: change.content,
                  })
                }
              })
              return toolOk({
                checkpoint: plan.checkpoint,
                restored,
                removed,
                skipped,
                unrestorable: plan.unrestorable,
              })
            }),
          })
        case 'diff':
          return tool({
            description:
              'Show what changed in one workspace file: against the previous journaled state by default, or against a checkpoint id passed as `since`.',
            inputSchema: jsonSchema<{ path: string; since?: string }>({
              type: 'object',
              properties: { path: { type: 'string' }, since: { type: 'string' } },
              required: ['path'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              if (!workspace) throw new ToolRuntimeUnavailableError(name)
              const path = readString(input, 'path') ?? ''
              if (path.length === 0) return toolFail('invalid_input', 'path must be a workspace path.')
              const since = readString(input, 'since')
              const base = journal.baseContentFor(path, since)
              if (base === undefined) {
                return toolFail(
                  'not_found',
                  since === undefined
                    ? `No journaled change exists for "${path}".`
                    : `No checkpoint has id "${since}".`,
                  since === undefined
                    ? {}
                    : { hint: 'Pass the id returned by checkpoint, not its label.' },
                )
              }
              const current = await withPathLock(path, () => readForJournal(workspace, path))
              if (!current.known) {
                return toolFail('limit_exceeded', `"${path}" is too large to diff.`)
              }
              const result = journal.diff(base, current.content)
              return toolOk({
                path,
                since: since ?? 'previous',
                changed: result.changed,
                addedLines: result.addedLines,
                removedLines: result.removedLines,
                truncated: result.truncated,
                diff: result.changed ? `--- a/${path}\n+++ b/${path}\n${result.text}` : '',
              })
            }),
          })
        case 'history':
          return tool({
            description:
              'List recent journaled workspace changes, optionally filtered to one path. Reports hashes and kinds, not file contents.',
            inputSchema: jsonSchema<{ path?: string; limit?: number }>({
              type: 'object',
              properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const path = readString(input, 'path')
              const limit = readNumber(input, 'limit')
              return toolOk({
                entries: journal.history(path, limit ?? 50),
                checkpoints: journal.checkpoints(limit ?? 50),
              })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
