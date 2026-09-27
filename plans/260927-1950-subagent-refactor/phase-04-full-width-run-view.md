---
phase: 4
title: Full-width run view
status: done
---

# Phase 4 — Full-width run view

## Goal

Opening a run replaces the main thread area with a full-width run view. Back
returns to the conversation.

## Files

- Add: `src/ui/agent-run-view.tsx` (replaces `src/ui/panels/agent-flow-view.tsx`)
- Modify: `src/ui/shell.tsx`, `src/session/agent-panel-state.ts`,
  `src/components/assistant-ui/elements/tool-view/details/agents.tsx`,
  `src/components/assistant-ui/elements/sub-agent-report.aui.tsx`
- Tests: new `src/ui/agent-run-view.test.tsx`, which ports every case from
  `agent-flow-view.test.tsx` plus the reproduction cases from phase 1

## Steps

1. `agent-panel-state.ts`:
   - Keep `selectedRunId`, `open`, and `clear`.
   - `open` no longer reveals the rail.
   - Clear the selection when the active conversation changes.
2. `shell.tsx`: in `<main>`, render `<AgentRunView runId=… />` when
   `selectedRunId` is set, otherwise the existing `<Thread />`. Remove the
   subscription that opens the rail on selection.
3. `AgentRunView`:
   - Header: back button ("← Conversation"), run label, status (spinner or dot
     plus word), mode and tier chips, elapsed time, and tool count.
   - Pending approvals render as `AgentApprovalCard`s above the messages.
   - Body: `AssistantRuntimeProvider` wrapping `ThreadShell` (with
     `readOnly`), `ThreadMessage`, and a `SteerComposer` footer.
   - Data comes from the live record, or else the persisted thread after
     `rehydrateThread` and `repairLegacyRunMessages`.
   - Errors and the stopped notice appear as inline banners.
4. Esc and the back button return to the conversation and restore focus to the
   element that opened the view.
5. Entry points call `useAgentPanelStore.getState().open(runId)`: the Agents
   rail rows, the `spawn_agent` / `read_agent` / `stop_agent` action, and a new
   "Open run" action on the `SubAgentReport` card.

## Validation

- Tests pass for:
  - opening from each entry point,
  - back and Esc,
  - a live run that becomes settled,
  - a persisted run after reload showing real `list_dir` entries,
  - a legacy run showing "result not recorded".
- The main `Thread` still mounts when nothing is selected.
