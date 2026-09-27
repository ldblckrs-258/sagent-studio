---
title: "Agent panel steering and control"
description: "Upgrade the Agents right-panel to a master/detail flow view with live steering, force-stop, markdown rendering, and main-thread stop/read tools."
status: completed
priority: P1
effort: 5d
branch: main
tags: [feature, agents, frontend, orchestration]
blockedBy: []
blocks: []
created: 2026-09-22
---

# Agent panel steering and control

## Overview

Upgrade the delegated-agent experience end to end. The Agents right-panel gets a
master/detail flow view that matches the `spawn_agent` tool-call visual language
and renders sub-agent output as markdown. Selecting a run opens its live flow and
lets the user append a steering message mid-run. A force-stop control, on both
the panel and the main thread, returns a `stopped` (reason `user_stop`) result to
the parent conversation. The main model gains `stop_agent` and `read_agent` tools
so the parent can stop a child and read its last N turns. A sub-agent report now
renders inline in the parent turn at the moment it arrives instead of always at
the end of the turn.

## Decisions (user-confirmed)

| Topic | Decision |
|-------|----------|
| Mid-run append | Inject at the next step boundary in the same run (`prepareStep` + outer continuation loop). No abort/restart. |
| Stop status | New `AgentRunStatus: 'stopped'` with `stopReason: 'user_stop'`, distinct from system `aborted`. |
| Force-stop surface | Both a model tool (`stop_agent`) and a user control (panel + row). |
| Retrieval tool | `read_agent` returns the last N text turns (`lastN`, default 6, clamped), with an optional `includeTools` flag. |
| Flow view location | Master/detail inside the existing Agents panel; back button returns to the list. |

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Steering: a live run accepts an injected user message at the next step and continues. | P1 |
| 2 | Stop semantics: `stopped` status + `user_stop` reason reach the parent notice and the child thread. | P1 |
| 3 | Main-thread tools: `stop_agent` and `read_agent (lastN)`, parent-scoped. | P1 |
| 4 | Agents panel master/detail: click a run to see its flow, steer it, force-stop it. | P1 |
| 5 | Visual sync with the `spawn_agent` tool-call view and markdown rendering on every sub-agent response surface. | P1 |
| 6 | Sub-agent report renders inline at arrival instead of always at the end of the parent turn. | P1 |
| 7 | Docs, e2e coverage, and lint/build/type gates. | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Steering and stop runtime](./phase-01-steering-and-stop-runtime.md) | Completed |
| 2 | [Runtime control surface and parent notices](./phase-02-runtime-control-ports.md) | Completed |
| 3 | [Agent control tools: stop_agent and read_agent](./phase-03-agent-control-tools.md) | Completed |
| 4 | [Markdown rendering and tool-view visual sync](./phase-04-markdown-and-visual-sync.md) | Completed |
| 5 | [Agents panel master/detail, composer, force-stop](./phase-05-agents-panel-master-detail.md) | Completed |
| 6 | [Sub-agent notice appears inline at arrival](./phase-06-subagent-notice-inline.md) | Completed |
| 7 | [Docs and end-to-end verification](./phase-07-docs-and-verification.md) | Completed |

## Cross-Plan Dependencies

| Relationship | Plan | Status |
|-------------|------|--------|
| Extends | `260922-1354-sub-agent-delegation` | Completed |

## Dependencies

- Phase 2 needs Phase 1 (steering and stop live in the runner and store).
- Phase 3 needs Phase 2 (the port exposes stop/read).
- Phase 4 is independent of Phases 1-3 (pure UI) but sequences before Phase 5 so
  the panel builds on the shared markdown and chip modules.
- Phase 5 needs Phases 1-4.
- Phase 6 is independent of Phases 1-5 (engine and transcript only) but lands
  before the docs gate.
- Phase 7 needs all phases.
- No new runtime dependency; no new network egress.

## Success Criteria

- [x] A running sub-agent receives a user steering message at its next step and
  responds within the same run; the message is visible in the flow.
- [x] Force-stop produces `status: stopped` with reason `user_stop` on the child
  thread and in the parent notice.
- [x] The main model can call `stop_agent` and `read_agent` (last N turns); both
  are scoped to the calling conversation.
- [x] Clicking a run in the Agents panel opens its flow with a working composer
  and force-stop, and a back action.
- [x] Sub-agent responses render markdown in the panel, the tool-call detail, and
  the background notice card.
- [x] A sub-agent report appears inline at the moment it arrives, mid-turn, and
  survives further stream chunks and a reload.
- [x] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Validation Log

Contract confirmed with the user through the brainstorm gate (five decisions in
the table above), plus a follow-up decision to render sub-agent reports inline
mid-turn rather than at the end of the turn. No open questions remain.

### Completion notes

- All seven phases implemented; `pnpm test` (134 files, 1557 passed, 1 skipped),
  `pnpm lint`, and `pnpm build` pass.
- **Single-writer deviation:** Phase 1 steps 3 and 4 both recorded the steering
  `user-message` event, which duplicated the turn in the flow. The runner now
  records it when it drains the queue (the chronological injection point); the
  store only enqueues. Persisted child transcripts also carry steering turns, so
  `read_agent` and a reloaded panel flow match a live run.
- **Independent review remediation:** a fresh-context review found and the
  implementation fixed one High (inline notices were not model-visible: a
  `convertDataPart` mapping now feeds them to `convertToModelMessages` in both
  the run path and compaction) and four Medium findings (read tool-turn parity
  across live/reloaded runs, honest `steer` rejection once a channel closes,
  steering history continuity across `prepareStep` injection, and an aggregate
  `read_agent` output cap). See `reports/review-remediation.md`.
- **UI refactor (post-implementation request):** the Agents panel mounts an
  assistant-ui runtime for the selected run and reuses the main thread's real
  conversation rendering (`ThreadMessage`, including markdown and tool-call
  views) and its `ComposerPrimitive` message input, instead of a bespoke
  timeline. A live run's events are projected into the same `UIMessage` shape
  (`src/agents/run-messages.ts`, `src/chat/use-subagent-runtime.ts`). The list is
  sectioned (Active / Recent), and a sub-agent tool call in the transcript
  carries an always-visible panel action that selects its run through
  `src/session/agent-panel-state.ts`. The completed `spawn_agent` result now
  carries its `runId` so an awaited run is openable too.

### Red Team Review

Four hostile lenses (Assumptions, Failure, Scope, Security) produced 13
findings; all High/Medium findings were accepted and folded into the phases. See
`reports/red-team.md`. Key hardening:

- Inject a steering message only when the message tail is a tool result or
  assistant message (Phase 1).
- Cap total steps across outer passes (Phase 1).
- `read` is async and `resolveRun` is an explicit runtime/port method so a label
  can never be guessed (Phases 2, 3).
- `BLOCKED_AGENT_TOOLS` gains `stop_agent` and `read_agent` (Phase 3).
- Ownership is re-checked in every runtime method, not just the port closure
  (Phase 2).

The notice-timing bug was diagnosed after the first validation pass and added as
Phase 6, with its own root-cause record (`src/chat/engine.ts:665-681`, `:986`,
`:1015`; test at `src/chat/engine.test.ts:1633-1661`).

No unresolved contradictions remain.

## Risks

- **SDK injection point:** `prepareStep` message override is confirmed present in
  `ai@7` (`node_modules/ai/dist/index.d.ts:1664-1753`), but the tail case (agent
  finished its step loop with a queued steering message) needs the outer
  continuation loop to avoid a dropped message.
- **Run identity in tools:** tools act by `runId` or `label`; a label is not
  unique. The port must reject an ambiguous label rather than guess.
- **Persistence shape:** adding `stopReason`, user-steer parts, and the
  `data-agent-notice` part changes the child/parent envelope; the sanitizer must
  keep data parts and accept older threads unchanged.
- **Stream write merge:** the in-place update must preserve injected notice parts
  and any paused approval part on a resumed run.

<!-- slug: agent-panel-steering -->
