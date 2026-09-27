---
type: brainstorm
date: 2026-09-27
topic: Sub-agent feature refactor (panel list, run thread, tool results, composer)
status: awaiting-decision
---

# Sub-agent refactor — brainstorm

## Summary

The sub-agent feature has three separate hand-written projections of the same
run (live event log to UIMessage, event log to persisted transcript, and two
turn projections for `read_agent`), while the main thread uses the AI SDK's own
`toUIMessageStream` + `readUIMessageStream` pipeline. Most visible defects are
drift between those projections. Recommendation: make the runner emit real
`UIMessage` snapshots through the same pipeline as `src/chat/engine.ts`, store
and persist those messages directly, and rebuild the panel on top of the main
thread's shell instead of a look-alike.

## Contract

- **Outcome:** a sub-agent run looks and behaves like a first-class
  conversation. Every tool call inside a run shows its real result, live and
  after reload. The Agents list is scannable. The run thread uses the same
  message layout and the same composer look as the main thread, with steering
  and stop controls.
- **Constraints:** fully client-side; AI SDK 7.0.105 and assistant-ui 0.15.20;
  keep public tool contracts (`spawn_agent`, `stop_agent`, `read_agent`)
  compatible; keep one-level delegation, concurrency caps, approval queue and
  steering semantics; existing persisted child threads must still open.
- **Non-goals:** nested delegation, changing the model/tier system, redesigning
  the main thread, new agent capabilities.
- **Acceptance criteria:**
  1. A run that calls `read_file`, `grep`, and a failing tool shows the real
     result or error for each, both live and after a page reload (test + live
     browser check).
  2. A tool call still executing shows as running, never as done or empty,
     including in a mid-run persisted snapshot.
  3. Denied tool calls show as denied, not as an empty success.
  4. The run thread renders with the main thread's width, spacing, bubble, and
     tool views; the composer shares the main composer's shell, input, and
     round send/stop buttons.
  5. The list shows per-run label, status, current activity, elapsed time, and
     tool count, grouped Active / Recent.
  6. `pnpm test`, `pnpm lint`, `tsc -b`, and `pnpm build` pass.

## Evidence

- `src/chat/engine.ts:453-480` streams with `result.stream` into
  `toUIMessageStream` and reads parts with `readUIMessageStream`.
- `src/agents/runner.ts` iterates the deprecated `result.fullStream` and
  forwards only `text-delta`, `tool-call`, `tool-result`, `tool-error`. It drops
  `tool-output-denied`, approval request/response parts, reasoning, and
  `preliminary` flags.
- `src/agents/run-messages.ts` (live) and `transcript()` in
  `src/agents/runtime.ts:238` (persisted) are two independent projections of the
  same event log:
  - `transcript()` seeds each tool call as `state: 'output-available', output: {}`
    before its result exists, so a mid-run persisted snapshot shows a running
    tool as a finished tool with an empty result.
  - `transcript()` ignores `tool-error`, so a failed call persists as a success
    with `{}`.
  - Both projections convert a denied call, or any call left open when the run
    settles, into `output-available` with `{}`. Tool views then render an empty
    result.
- `plans/journals/2026-09-23-subagent-tool-results-live-flow.md` shows this
  already happened once: the live projection hardcoded `output: {}` while the
  test asserted `{}`.
- `src/chat/use-subagent-runtime.ts` hardcodes `isRunning: false`, so
  assistant-ui never shows running state for the run, and the last message's
  unresolved tool call gets a `requires-action` status (caution icon) rather
  than running.
- `src/ui/panels/agent-flow-view.tsx` mounts `ThreadPrimitive.Viewport` without
  the main thread's layout variables (`--thread-max-width`, `--composer-*`,
  paddings) and builds its own composer: a text `Send` button, a danger `Stop`
  button, and a helper line. The main composer
  (`thread.aui.tsx:513-596`) uses `ComposerDropzone`, highlight, controls, and
  round icon buttons (`ComposerAction`). That is why the panel input looks
  worse.
- `src/ui/panels/agents.tsx` rows show only a dot, a truncated title, a status
  word, and chips. There is no current activity, tool count, or progress, and
  status and chip vocabulary is duplicated (`STATUS_DOT` in two files).

The literal text "no response" does not appear in `src/`. The closest strings
are "(no output)" (flow view), "No result was recorded for this delegation"
(the `spawn_agent` card in the main thread), and empty `Result` sections from
`{}` outputs. The exact symptom is not reproduced yet (see open questions).

## Options

### A. Patch in place

Fix `transcript()` seeding and `tool-error`, handle denied calls, set a real
`isRunning`, restyle the list and composer.

- Depends on: the three projections staying in sync by discipline.
- Fails first: the next AI SDK part type (reasoning, preliminary output,
  approval parts), which has to be added in three places. This has already
  broken once.
- Cost: small. It is cheap to abandon but does not remove the bug class.

### B. One message pipeline (recommended)

- The runner consumes `result.stream` through `toUIMessageStream` and
  `readUIMessageStream`, the same way `engine.ts` does, and pushes
  `UIMessage[]` snapshots into `agentRunStore`. Steering turns are appended as
  user messages.
- Store and persistence hold `messages: UIMessage[]`. `transcript()`,
  `run-messages.ts`, and `turnsFromRecord` are deleted. `read_agent` keeps only
  `turnsFromMessages`.
- The runtime reports a real `isRunning` and maps `onCancel` to stop. Steering
  uses a send button that stays enabled while running, instead of the main
  composer's queue.
- UI: extract the main thread's layout shell and composer building blocks
  (shell, input, `ComposerAction`) so the panel composes the same pieces. The
  sub-agent composer omits model, mode, and attachment controls. Rebuild the
  list rows with activity and tool count taken from the latest message.
- Depends on: `toUIMessageStream` output from a runner loop that re-enters
  `streamText` for steering. It works in the engine, but the loop needs
  `originalMessages` threading.
- Fails first: old persisted child threads written by `transcript()` (tool
  parts with `{}`). Keep `normalizeThreadMessages` as a read-time migration
  only.
- Cost: medium. It touches runner, store, runtime, persistence, panel, and
  tests.

### C. Run sub-agents on the main ChatEngine

- Depends on: the engine being decoupled from the parent chat store, which it
  is not today.
- Fails first: side effects on the parent conversation (usage metering,
  compaction, queue).
- Cost: large, with the highest regression risk. Not recommended now.

## Recommendation

Choose B. It removes the root cause of the tool-result bugs (three projections)
and makes "same UI as the main thread" structural instead of copied. Deliver it
in phases: (1) pipeline + store + persistence with a migration, (2) runtime
status and steering, (3) shared thread shell + composer, (4) list redesign,
(5) live browser verification.

Before starting, commit or stash the current uncommitted agent-panel-steering
work (40+ modified files, several untracked). Otherwise the refactor diff mixes
with it.

## Unresolved questions

1. Where exactly do you see "no response": inside the Agents panel run thread,
   or on the `spawn_agent` card in the main chat? Live, or after a reload? A
   screenshot would settle this.
2. May I start the sagent-studio dev server (not running now) to reproduce the
   bug live before planning?
3. Approach B, or a smaller A first?
4. Should the run thread stay in the side panel, or open as a full-width view
   like a conversation?
