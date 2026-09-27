---
title: Sub-agent refactor — one message pipeline, full-width run view
status: in-progress
created: 2026-09-27
branch: main
brainstorm: ../reports/brainstorm-260927-1917-subagent-refactor.md
---

# Sub-agent refactor

## Outcome

A delegated run is a first-class conversation. Every tool call inside a run
shows its real result, both live and after a reload. A run opens full-width in
the main area, using the same thread layout, message components, and composer
look as the main thread. The Agents rail lists runs in a scannable way.

## Constraints

- Fully client-side. AI SDK 7.0.105, assistant-ui 0.15.20.
- Tool contracts for `spawn_agent`, `stop_agent`, and `read_agent` stay
  compatible.
- One-level delegation, the concurrency caps, the approval queue, and the
  steering and stop semantics are unchanged.
- Persisted child threads written by the old `transcript()` still open.
- Do not start the dev server or run builds without the user's go-ahead
  (user rule). Tests and lint are allowed.
- No code comments (user rule).

## Non-goals

Nested delegation, model or tier changes, a main-thread redesign, and new agent
capabilities.

## Preconditions

- Commit or stash the uncommitted agent-panel-steering work first. The working
  tree has 40+ modified files and several untracked ones.

## Phases

| # | Phase | Depends on | Status |
|---|-------|------------|--------|
| 1 | [Run message pipeline](phase-01-run-message-pipeline.md) | — | done |
| 2 | [Sub-agent runtime behavior](phase-02-subagent-runtime.md) | 1 | done |
| 3 | [Shared thread shell and steer composer](phase-03-thread-shell-and-composer.md) | 2 | done |
| 4 | [Full-width run view](phase-04-full-width-run-view.md) | 3 | done |
| 5 | [Agents list redesign](phase-05-agents-list.md) | 1 | done |
| 6 | [Cleanup, docs, verification](phase-06-cleanup-and-verification.md) | 4, 5 | in-progress (build + browser check pending user go-ahead) |

Phases 1 → 2 → 3 → 4 are sequential. Phase 5 can start after phase 1.

## Architecture

```
streamText(result.stream)
  → toUIMessageStream (same as src/chat/engine.ts)
  → readUIMessageStream → partial assistant UIMessage
  → splitAtSteers(prompt, passes, steers) → UIMessage[]
  → agentRunStore.setMessages(runId, messages)      (live)
  → persistence snapshot.messages = record.messages  (throttled + final)

AgentRunView (main area, full-width)
  ├─ useSubAgentRuntime(messages, { isRunning, onSteer, onStop })
  ├─ ThreadShell (extracted from ThreadRoot)  → ThreadMessage (unchanged)
  └─ SteerComposer (main composer shell, input, round send/stop)
```

## Acceptance criteria

1. A run calling `list_dir`, `read_file`, and a failing tool shows the real
   entries, lines, and error, both live and after a reload. Covered by tests at
   the panel level and checked in the browser.
2. A tool call still executing renders as running (spinner), never as done,
   empty, or an Allow/Deny prompt. This includes a mid-run persisted snapshot.
3. Denied calls render as denied. Legacy runs with a lost result render "result
   not recorded", not "0 entries".
4. The run view has the main thread's width, spacing, bubbles, tool views, and
   composer look. No Regenerate or Edit actions appear on run messages.
5. List rows show label, status, current activity, tool count, and elapsed
   time, grouped Active / Recent, with a pending-approval marker.
6. `pnpm test`, `pnpm lint`, and `pnpm exec tsc -b` pass. `pnpm build` and the
   browser check run only after the user's go-ahead.

## Diagnosis note

Probes on 2026-09-27 found no loss in the AI SDK v7 stream, the live
projection, or the runtime → persistence path under a mock model. The user's
"0 entries" symptom therefore comes from a path the tests do not cover. One
confirmed source is runs persisted before the 09-23 fix, which have `{}` baked
in. Phase 1 opens with a failing test at the panel level for reload,
interrupted, and denied cases. The refactor removes all three hand-written
projections, so the bug class goes away regardless of which trigger it is.
The probes also found two defects to fix in phase 2: running tools render
Allow/Deny, and run messages show Regenerate.

## Risks

- `ComposerPrimitive.Send` may be disabled while `isRunning`. Phase 3 verifies
  this and falls back to `useComposerRuntime().send()` from a custom button.
- Splitting one pass's assistant message at a `prepareStep` steer. This is a
  pure function with its own tests.
- Legacy threads. The read-time repair is kept, and lost results are shown
  honestly.
