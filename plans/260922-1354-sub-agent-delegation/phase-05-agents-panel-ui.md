---
phase: 5
title: "Agents panel and approval queue UI"
status: completed
priority: P1
effort: 1.5d
dependencies: [4]
---

# Phase 5: Agents panel and approval queue UI

## Overview

Give delegated work a visible surface: a rail panel listing every agent run with
its label, mode, tier, and status; a live transcript of streamed text and tool
calls; a cancel action; and Allow/Deny cards for approvals a background agent has
queued. A badge on the rail button and the existing approval sound make a paused
agent impossible to miss.

## Key Insights

- `src/ui/shell.tsx:319-363` is the single place rail panels are declared: add an
  `agents` id, a `Bot`-style icon, and a render entry; the badge reads the same
  store the panel reads.
- The panel must re-render on store mutation the way `ComposerControls` does for
  the skill registry; `useRegistryVersion` (`src/ui/use-registry-version.ts`) is
  the existing idiom, and the agent store should expose the same subscribe/version
  shape rather than a bespoke hook.
- Agent approvals are not message parts, so `approval-prompt.tsx` (which reads
  `findPendingApproval` off messages) cannot render them. Render the queue from
  the agent store so one component serves all runs.
- Runs are durable: the panel lists persisted child agent threads
  (`listAgentRuns(parentThreadId)`), overlays live streaming events for running
  ones, and shows `interrupted` children after a reload. The in-memory store
  clears on vault lock (`src/chat/store.ts:169-174`); persisted children are
  re-read on unlock.
- **No redaction helper exists today.** `approval-prompt.tsx:50-58,91-93` renders
  `JSON.stringify(input)` raw, and `redactSecrets` is applied only to errors
  (`src/chat/engine.ts:452`). HTTP tool inputs can carry `Authorization` headers
  (`src/tools/http.ts:160-166`). Introduce one `redactForDisplay(value)` helper and
  use it in both the existing prompt and the new cards — do not claim reuse where
  none exists.
- Delegated approvals are Allow/Deny only: offering "Always allow" would write a
  global policy for a tool the user may not have realized a detached agent chose
  (`src/chat/engine.ts:307-314`).

## Requirements

- A rail panel listing runs for the active thread newest first, each showing
  label, mode, tier, status, and elapsed time; persisted children load first and
  live runs overlay them.
- An expandable transcript of `text-delta`, `tool-call`, `tool-result`, and
  `approval-requested` events; an error state renders the run's message.
- A cancel button per running run that aborts it; a clear action for settled runs.
- Approval cards with Allow and Deny only; Deny stops that tool while the run
  continues; aborting the run settles any pending card as denied.
- Rail badge count of pending approvals that opens the panel when clicked.
- Every rendered tool input passes through `redactForDisplay`.

## Related Code Files

- Create: `src/tools/redact.ts`
- Create: `src/tools/redact.test.ts`
- Create: `src/ui/panels/agents.tsx`
- Create: `src/ui/panels/agents.test.tsx`
- Create: `src/ui/agent-approval.tsx`
- Create: `src/ui/agent-approval.test.tsx`
- Modify: `src/ui/approval-prompt.tsx` (route inputs through `redactForDisplay`)
- Modify: `src/ui/shell.tsx`
- Modify: `src/agents/store.ts` (version + selectors)
- Modify: `src/agents/store.test.ts`

## Implementation Steps

1. `src/tools/redact.ts`: `redactForDisplay(value)` deep-clones plain data,
   replaces values under sensitive keys (`authorization`, `apiKey`, `token`,
   `secret`, `password`, `cookie`, case-insensitive) with `[redacted]`, and runs
   `redactSecrets` over remaining strings. Reuse this in `approval-prompt.tsx` and
   the new cards.
2. Extend `src/agents/store.ts` with a version counter and selectors for
   runs-by-thread, pending approvals, and the badge count.
3. `src/ui/agent-approval.tsx`: renders one pending approval (run label, tool
   name, redacted input) with Allow and Deny, calling
   `agentStore.resolveApproval(id, allowed)`; chime on first paint via
   `approval-sound.ts`.
4. `src/ui/panels/agents.tsx`: loads persisted child runs via
   `listAgentRuns(activeThreadId)`, overlays live store events, and renders the
   run list, status chips, transcript viewer, cancel, clear, and embedded
   approval cards, following the `PanelFrame` body idiom.
5. `src/ui/shell.tsx`: add `"agents"` to `RailPanelId`/`RAIL_IDS`, a `Bot` icon
   entry rendering `<AgentsPanel />`, and a count badge that opens the panel.
6. Tests: `redact.test.ts` (sensitive keys, nested, string patterns);
   `agents.test.tsx` (render by status, expand transcript, cancel);
   `agent-approval.test.tsx` (Allow/Deny resolves the store; abort settles as
   denied); `store.test.ts` (version increments, clear).

## Todo

- [x] `redactForDisplay` helper + tests, applied to the existing approval prompt
- [x] Store version + selectors
- [x] Agent approval cards (Allow / Deny only)
- [x] Agents rail panel (list, transcript, cancel, clear, errors)
- [x] Shell rail entry + approval badge
- [x] Component tests

## Success Criteria

- A running background agent appears immediately and its transcript updates as it
  streams.
- A queued approval is answerable from the panel; Deny stops that tool and the run
  continues; cancel settles pending cards as denied.
- No API key or `Authorization` header text appears in any rendered tool input.
- `pnpm test` for the touched suites passes; `pnpm lint` passes.

## Risk Assessment

- **Accessibility:** badge and cards need labels and keyboard focus; follow the
  existing `aria-*` usage in the rail and approval prompt.
- **Stale runs after lock:** the agent store must clear with `useChatStore` on
  lock, mirroring `src/chat/store.ts:169-174`, or the panel shows zombies.
- **Redaction regressions:** the helper must not throw on non-plain inputs
  (functions, class instances) — return a safe placeholder.

## Security Considerations

- Delegated approvals never persist and never offer "always allow".
- Redact before render, not after, so a value never reaches the DOM un-redacted.

## Next Steps

- Phase 6 documents the feature and adds the end-to-end test.
