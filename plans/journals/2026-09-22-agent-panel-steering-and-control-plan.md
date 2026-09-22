---
title: Agent panel steering and control plan
date: 2026-09-22
summary: "Brainstormed and red-teamed a six-phase plan to add live steering, force-stop, markdown flow view, and stop/read tools to the Agents panel"
---

# Agent panel steering and control plan

## Context

Extended the shipped sub-agent delegation feature
(`plans/260922-1354-sub-agent-delegation`) with three user requests: upgrade the
Agents right-panel UI and render sub-agent output as markdown, let the user open
an agent's flow and steer it mid-run with a force-stop, and give the main thread
a stop capability plus a tool to read a child's last N turns. The user then added
a bug: the sub-agent response UI always shows at the end of the turn. Plan lives
at `plans/260922-1950-agent-panel-steering`.

## Evidence gathered

- The Agents panel (`src/ui/panels/agents.tsx`) is a collapsible list with
  plaintext `<pre>` transcripts; the `spawn_agent` tool view
  (`tool-view/details/agents.tsx`) has a much richer tier/mode/divider language
  the panel does not share.
- Three surfaces print sub-agent output as plaintext: the panel, the tool detail
  reply, and `sub-agent-report.aui.tsx`.
- The rail panel renders outside `AssistantRuntimeProvider`, so the
  assistant-ui `MarkdownText` primitive is unusable there; `react-markdown`
  (`file-view/markdown-view.tsx`) is the viable renderer.
- `ai@7` exposes `prepareStep` with a `messages` override
  (`node_modules/ai/dist/index.d.ts:1664-1753`), confirming a real mid-run
  injection point. `AgentRunStatus` has no `stopped`; `AgentSpawnPort` has only
  `spawn`.

## Decisions (user-confirmed)

- Mid-run append injects at the next step boundary in the same run, no restart.
- New `AgentRunStatus: 'stopped'` with reason `user_stop`.
- Force-stop exists as both a model tool and a user control.
- `read_agent` returns the last N text turns (`lastN` default 6, clamped).
- Flow view is master/detail inside the existing Agents panel.
- Sub-agent reports render inline mid-turn, not appended at the end of the turn.

## Scope added after first pass: notice timing bug

The user reported that a sub-agent response always shows at the end of the parent
turn. Root cause proven in `src/chat/engine.ts`: `appendAgentNotice` queues while
`inFlight > 0` and `flushNotices` runs only in the run `finally`
(`:665-681`, `:721-728`, `:909`); the queue exists because the streaming loop
rebuilds messages from a stale `siblings` snapshot each chunk (`:986`, `:1015`,
`:1032`) and would drop a mid-run notice. The existing test
(`src/chat/engine.test.ts:1633-1661`) encodes the buggy behavior. Added as Phase 6
(inline `data-agent-notice` part + in-place stream write) with tests.

## Red Team

Four lenses found 13 issues, all accepted. The substantive ones: inject only when
the message tail is a tool result or assistant message; cap total steps across
outer passes; make `read` async (persistence) and add an explicit `resolveRun` so
a label is never guessed; add the new control tools to `BLOCKED_AGENT_TOOLS`; and
re-check parent ownership in every runtime method rather than trusting the port
closure.

## Outcome

Plan validated (`ak plan validate`) and indexed; seven phases, no open questions.
Next: `/ak:cook plans/260922-1950-agent-panel-steering/plan.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
