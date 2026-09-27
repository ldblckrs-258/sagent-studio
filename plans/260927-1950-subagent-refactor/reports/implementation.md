---
type: implementation-report
date: 2026-09-27
plan: ../plan.md
status: done-pending-browser-check
---

# Sub-agent refactor — implementation report

## Outcome

Phases 1–5 are done, and phase 6 is done except for the build and the browser
check, which wait for the user's go-ahead.

- A sub-agent run now produces real `UIMessage`s through the same AI SDK
  pipeline as the main engine (`toUIMessageStream` + `readUIMessageStream`).
- Store, persistence, `read_agent`, the Agents list, and the new full-width run
  view all read those messages. The three hand-written projections are gone.

Baseline commit `b10a6b5` holds the earlier agent-panel-steering work.

## Verification

- `pnpm test`: 136 files, 1585 passed, 1 skipped (baseline was 135 / 1565).
- `pnpm lint` and `pnpm exec tsc -b` are clean.
- Not run: `pnpm build` and the live browser check, both pending user approval.

## What changed

- `src/agents/runner.ts`: tees `result.stream` into an accounting branch and a
  UI-message branch.
  - Steers are recorded by `stepNumber`.
  - Completed passes are frozen, so each chunk rebuilds only the live pass.
  - The UI branch is always awaited, and its errors surface as the run failure.
  - Emits stop once the run settles; the final transcript is sanitized.
  - `toolCalls` is counted from the transcript.
- `src/agents/run-transcript.ts` (new):
  - `buildRunMessages` / `passMessages` lay out the transcript.
  - `toolCallCount` is the single tool counter.
  - `repairLegacyRunMessages` makes an old `{}` result read "not recorded".
- `src/agents/store.ts`: `events` became `messages`, and `appendEvent` became
  `setMessages`.
- `src/agents/runtime.ts`:
  - Persists `record.messages`.
  - Saves are chained per run, so a late mid-run save cannot overwrite the
    settled status.
  - `transcript()` and `turnsFromRecord` are removed.
- `src/agents/types.ts`: `AgentRunEvent` is removed.
- `src/chat/use-subagent-runtime.ts`:
  - Real `isRunning`.
  - `onCancel` stops the run.
  - An `ExternalThreadQueueAdapter` routes a send made while running to steering.
  - No `onEdit` / `onReload`.
- `src/components/assistant-ui/elements/thread.aui.tsx`:
  - `ThreadShell` extracted; `ThreadRoot` markup is unchanged.
  - `ComposerSendButton` / `ComposerCancelButton` extracted.
  - Refresh and Edit are gated on runtime capabilities.
- New files:
  - `src/ui/agent-run-view.tsx`: the full-width run view.
  - `src/ui/steer-composer.tsx`: the steering composer.
  - `src/ui/agent-status.ts`: done by a subagent, see `phase-05.md`.
- `src/ui/shell.tsx`: swaps the main thread for the run view when a run is
  selected, and clears the selection when the conversation changes.
- `src/ui/panels/agents.tsx`: list-only. It hides approvals for the run that is
  open in the run view.
- Entry points: the `spawn_agent` card and `SubAgentReport` both have an
  **Open run** action. The report keeps showing the run id.
- Deleted: `src/agents/run-messages.ts`, `src/ui/panels/agent-flow-view.tsx`, and
  their tests.
- `README.md`: the agents section is updated.

## Diagnosis of "0 entries"

The failure could not be reproduced under a mock model. Four boundaries were
probed, and all four kept the real output: the AI SDK v7 stream, the live
projection, incremental rendering, and runtime-to-persistence.

- **Confirmed source:** runs persisted before the 09-23 fix have `{}` baked in.
  These now read "not recorded".
- **Structurally removed:** the old `transcript()` wrote every tool call as
  finished with `{}` before its result existed, and ignored tool errors.
- **Found and fixed during the work:**
  - A running tool rendered Allow/Deny because the runtime reported
    `isRunning: false`.
  - Run messages showed Refresh.
  - An optimistic steer made the in-flight tool render Allow/Deny.

## Review

An independent code-reviewer reported one high, three medium, and several low
findings. All of the following are fixed, each with a test:

| # | Finding | Fix |
|---|---------|-----|
| 1 | A steer echo while a tool runs made the tool render Allow/Deny | Pending steers render outside the runtime, in the footer |
| 2 | The UI branch could emit after the final sanitized transcript and swallowed errors | Always awaited; emits guarded after settle; errors surface |
| 3 | Every chunk rebuilt the whole run | Completed passes are frozen |
| 4 | A throttled save could land after the final save | Saves are chained per run; the test fails without the chaining |
| Low | Three tool counters | Merged into one |
| Low | Stale docblock | Updated |
| Low | Duplicate approval card | Hidden in the rail for the open run |
| Low | Run id removed from the report card | Restored |

## Open

- **Build and browser check.** Pending user approval. Scenario: a background
  agent runs `list_dir`, `read_file`, and a failing tool; check the results live
  and after a reload, steer mid-run, stop a run, and compare the composer look.
- **Rejected steer loses its text.** A steer rejected because the run settled at
  that same moment drops the typed text (low).
- **Run error not persisted.** A run's error text lives only in memory, so after
  a reload the view shows the status without the message.
