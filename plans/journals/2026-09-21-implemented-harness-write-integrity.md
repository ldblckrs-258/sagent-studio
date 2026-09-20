# Implemented: Harness Tool-Surface Integrity Fixes

Source: a field bug report from an agent session against the harness tool
surface (no plan file; scoped directly from the report and validated).

## Scope

Full P0 + P1 + P2 from the report, delivered in one batch.

- P0 parallel-write loss: `edit_file` did read → plan → write with no
  serialization, so two `edit_file` calls in one assistant step both read the
  same revision and the last write discarded the earlier, while both returned
  `ok`.
- P0 ambiguous success: mutations reported no before/after revision, so an
  applied edit and an overwritten one were indistinguishable.
- P0 search false negative: `runSearch` collapsed `list`/`read` failures into a
  bare `filesSkipped` counter; empty `hits` could not be told from "all files
  skipped".
- P1 sandbox blindness: the workers already inject a workspace bridge (`fs` in
  JS, a `workspace` module in Python) but the tool descriptions never said so,
  so the model probed Node/Python builtins and concluded it was blind.
- P1 `open_preview` returned only `{opened:true}` with no render feedback.
- P1 no diff/journal/rollback for workspace edits.
- P2: mode not in the system prompt, no project-instruction priming, skill index
  not task-routable, `update_plan` silently retexted ids, `read_file` had no line
  gutter, `file_info` leaked raw epoch ms, `list_dir` glob semantics undocumented.

## Implementation

New modules:

- `src/workspace/lock.ts` — per-path mutex (`withPathLock`) with canonicalized
  keys, used by `edit_file`/`write_file`/`remove`.
- `src/workspace/revision.ts` — `contentHash` fingerprint for optimistic
  concurrency.
- `src/workspace/journal.ts` — bounded, process-local write journal with
  checkpoints, restore plans, diffs, and history; cleared on workspace
  switch/dispose.
- `src/workspace/diagnostics.ts` — static checks (HTML tag balance, inline
  script syntax, JSON, dangling local refs) shared by `check` and `open_preview`.
- `src/tools/builtin/{check,history}.ts` — `check` and
  `checkpoint`/`restore`/`diff`/`history` providers.

Changed contracts:

- `edit_file` accepts `edits: [{old_string, new_string, replace_all?}]` (atomic
  multi-hunk) or the legacy pair, plus `expect_revision`; returns `applied`,
  `before_hash`, `after_hash`, `revision`, and `reason:"already_satisfied"`.
- `WorkspaceSearchResult.skipped?: [{path, reason}]`; `search` surfaces it.
- New `find_lines` tool and `WorkspaceApi.findLines` (chunked `file.slice` scan,
  works past the read size cap).
- System prompt gains `permission mode`, `project context` (AGENTS.md/README.md,
  untrusted), and a compact skill index when >8 skills; new `search_skills` tool
  is unioned into the pool under `allowedTools` narrowing.
- `update_plan` warns on id retexting; `read_file` gains `line_numbers`; 
  `file_info` gains `lastModifiedIso`/`ageMs`.
- `restore` is registered in the approval gate (`GATED_BUILTINS`/`EDITING_TOOLS`,
  not mode-granted), so it always asks before rewriting or deleting files.

## Review Disposition

A `code-reviewer` pass found two confirmed data-loss paths in the new journal, an
ungated `restore`, and several hardening gaps. All were fixed:

1. `restore` was absent from the approval map, so it auto-approved even in
   `read_only`. Now gated; regression test added.
2. `planRestore` treated pre-existing files with no pre-checkpoint entry as
   post-checkpoint creations and planned a delete. It now falls back to the
   earliest post-checkpoint entry's `before`, and only plans a delete when that
   `before` is genuinely null.
3. Checkpoints older than the retained journal window could still restore and
   delete. They now expire (`planRestore().expired`, surfaced as `not_found`).
4. `already_satisfied` could be set on a batch where an earlier hunk made a later
   hunk's absent `old_string` look present. The fallback now applies only to the
   first hunk, and the flag is true only when nothing was applied.
5. Lock keys are canonicalized (`src/x/../a.ts` shares a lane); `remove` is
   locked.
6. `findLines` uses a streaming `TextDecoder` so a multibyte character split
   across the 1 MiB chunk boundary survives.
7. HTML diagnostics ignore comments and raw-text bodies, allow optional-close
   elements, and no longer read `src=`-shaped strings inside inline JS.
8. Journal cleared on `setWorkspace`/`dispose`; `search` description states the
   50-reason cap.

## Verification

- `pnpm test`: 76 files, 772 passed / 1 skipped.
- `pnpm lint` clean; `tsc -b` clean; `vite build` clean.
- New regression coverage: lock serialization, multi-hunk atomicity, stale
  writes, already-satisfied, search skip reasons, `find_lines` incl. multibyte
  boundary, diagnostics/optional-close/comments, journal restore/expiry, restore
  gating, mode + project-instruction prompt sections, compact skill index,
  `search_skills`, plan retext warnings.

## Pending

- The artifact render gate is still user-side: `check`/`open_preview` give static
  diagnostics, not a real headless render.
- The journal is process-local and covers only mutations routed through the
  workspace tools; sandbox `fs.writeFile` and direct UI saves are not captured.

## Retest round 2 (2026-09-21)

A second field report found 7 issues; all fixed.

- B1 (red): `check` reported valid `<p>…<code>…</code>…</p>` as an error. The
  optional-close logic auto-closed any optional top on *any* start tag, so every
  inline tag closed `<p>`. Replaced with HTML5 auto-close rules: only block-level
  start tags close `<p>`, and `li`/`dt`/`dd`/`td`/`tr`/`option`/section elements
  close only their own families. Comments, raw-text bodies (`textarea`/`title`),
  and optional-end-tag omission are handled. This also fixes `open_preview`
  diagnostics, which share the module.
- B2 (red): replaying a fully applied multi-hunk batch returned `no_match` at the
  wrong `failedIndex`, breaking retry loops. `planPatchMulti` now judges
  "already satisfied" against the original revision for every hunk (so a replay
  is idempotent) and reports the true failing index.
- B3 (orange): the sandbox bridge rejected every call with "No workspace
  folder is open" even though the workspace tools saw the folder. Root cause:
  `createSandboxManager` bound the workspace by value at session construction,
  while the workspace tools read it through a live getter — a folder granted
  after the session opened never reached the sandbox. Fixed by threading a live
  `getWorkspace` resolver through `SandboxManagerOptions` → runner pairs →
  `WorkerSession` → `fs-bridge`, which resolves (or re-resolves) per `fs.call`;
  and the workspace-change subscription rebuilds via the same resolver. Tool
  descriptions state the async (`await`) contract, that `fs.list` resolves to a
  JSON string, and the workspace-folder precondition. Regression test grants the
  folder after the run starts and expects the `fs.call` to resolve.
- B4 (yellow): `search` with a file `path` returned `ok:true` and empty hits. It
  now stats the path and returns `invalid_input` pointing at `find_lines`.
- B5 (yellow): the journal diff had no line numbers. `diff` now emits
  `--- a/<path>`, `+++ b/<path>`, and a `@@ -start,count +start,count @@` header.
- B6 (green): `search_skills` renamed `total` to `scanned` and added `matched`.
- B7 (green): `search` documents breadth-first alphabetical order and skips
  `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo` by
  default, with `include_excluded: true` to opt back in.

Verification: `pnpm test` 76 files, 780 passed / 1 skipped; `pnpm lint` clean;
`tsc -b` clean; `vite build` clean.

## Approval chime on auto-approved tools (2026-09-21)

The approval popover's chime played for tools the policy auto-approves (e.g.
`write_file` in editing mode). Root cause is in the AI SDK, not the UI: for a
statically `approved`/`denied` policy the SDK still emits a `tool-approval-request`
with `isAutomatic: true` and then resolves it in the same stream, so the UI part
briefly sits in `approval-requested` and `findPendingApproval` counted it as
user-pending.

Fix: `isAutomaticApproval` (true for `approval.isAutomatic === true` or
`resolution === 'expired'`) is now honoured by both `findPendingApproval` (UI
prompt + chime) and the engine's `collectPendingApprovals` (so an automatic
request is never resumed or manually expired). Tests cover the automatic,
expired, and mixed-with-real cases.

## Retry resumes the failed step instead of replaying the turn (2026-09-21)

A turn's inline Retry routed to `engine.rerun`, which rebuilt the turn from the
preceding user message and discarded the assistant message, so every tool call
in the turn re-executed.

Fix: `rerun` detects a failed final assistant message and resumes it via
`startRun(..., { resumeAssistantId })`. The assistant message already carries
terminal tool parts with their outputs, so `convertToModelMessages` sends them
as completed tool calls and the model continues instead of re-running them. A
prior run error is cleared before the resume so the inline error does not
re-appear mid-stream. Regenerating a healthy turn, or reloading an older
message, still starts fresh. Tests assert the completed tool is not executed
again and that its result reaches the resumed prompt.


