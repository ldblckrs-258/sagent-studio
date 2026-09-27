---
phase: 2
title: Sub-agent runtime behavior
status: done
---

# Phase 2 — Sub-agent runtime behavior

## Goal

The assistant-ui runtime for a run reports real running state, routes the
composer to steering and stop, and exposes no history-editing actions.

## Files

- Modify: `src/chat/use-subagent-runtime.ts`,
  `src/components/assistant-ui/elements/thread.aui.tsx` (only a
  context flag for read-only history)
- Tests: new `src/chat/use-subagent-runtime.test.tsx`, plus the flow-view tests
  that move in phase 4

## Steps

1. Change the signature to `useSubAgentRuntime(messages, { isRunning, onSteer,
   onStop })`.
   - `isRunning` is real.
   - `onNew` calls `onSteer`.
   - `onCancel` calls `onStop`.
   - Do not provide `onEdit` or `onReload`, so assistant-ui reports those
     capabilities as unavailable.
2. **Fix, confirmed by probe:** a running tool currently renders Allow/Deny,
   because `isRunning: false` gives it `requires-action` status. With a real
   `isRunning` it must render the spinner. Test both states: running, and
   settled with a result.
3. **Fix, confirmed by probe:** run messages render Copy / Refresh / More. Add
   `readOnly?: boolean` to `ThreadComponents` and read it in `ThreadMessage`,
   to hide Reload, Edit, and Branch on both roles while keeping Copy. The main
   thread default is unchanged.
4. Keep the optimistic steer echo. Reconcile against user messages in
   `record.messages` instead of `user-message` events.

## Validation

- A test mounts the runtime with a running tool part and asserts a spinner with
  no Allow/Deny.
- A test asserts no Refresh or Edit on run messages.
- `pnpm exec vitest run src/chat src/ui src/components` passes.

## Risks

- `isRunning: true` shows the assistant-ui running indicator on the last
  message. This is intended, since it matches the main thread.
