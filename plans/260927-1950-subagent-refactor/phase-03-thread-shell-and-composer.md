---
phase: 3
title: Shared thread shell and steer composer
status: done
---

# Phase 3 — Shared thread shell and steer composer

## Goal

The run view composes the same layout and composer building blocks as the main
thread, so the two cannot drift.

## Files

- Modify: `src/components/assistant-ui/elements/thread.aui.tsx` (extract; no
  behavior change for the main thread), `src/ui/conversation.tsx`
- Add: `src/ui/steer-composer.tsx`
- Tests: `src/ui/steer-composer.test.tsx`, and the existing thread tests must
  stay green

## Steps

1. Extract `ThreadShell` from `ThreadRoot` and export it.
   - `ThreadShell` owns `ThreadPrimitive.Root` with the layout variables
     (`--thread-max-width`, `--composer-*`), the viewport, the message column,
     scroll-to-bottom, and a sticky footer slot.
   - Props: `children` (header slot, optional), `footer` (composer).
   - `ThreadRoot` becomes `ThreadShell` plus the main `Composer`, with
     identical markup.
2. Export the round icon buttons used by `ComposerAction` (send arrow, stop
   square) as small components. Do not duplicate their class strings.
3. `SteerComposer`:
   - `ComposerPrimitive.Root` with the `aui-composer-root` shell and the main
     input class set (without the highlight overlay).
   - Placeholder "Steer the agent…". When settled, the input is disabled and
     the placeholder shows the closed reason.
   - Right side: a round send button that stays enabled while running, and a
     round stop button while running. Show "Stopping…" state when a stop is
     requested.
   - No model, mode, or attachment controls.
4. **Verify** whether `ComposerPrimitive.Send` is disabled while
   `thread.isRunning`. If it is, the send button calls
   `useComposerRuntime().send()` directly, guarded on non-empty text.
5. Enter sends and Shift+Enter inserts a newline, as in the main composer.

## Validation

- A test types into the composer while running and asserts `onSteer` is called
  with the text and the input is cleared.
- A test asserts stop calls `onStop`, and that input is disabled when settled.
- Main thread tests are unchanged and pass. A snapshot or class check confirms
  the `ThreadRoot` output is identical.
