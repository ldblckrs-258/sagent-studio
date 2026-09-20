---
phase: 6
title: "Phase 6: Context meter UI"
status: done
priority: P1
effort: "5h"
dependencies: [1, 3, 5]
---

# Phase 6: Context meter UI

## Goal

Render the token totals, the context-versus-cap meter, and the tokens-per-second readout directly below the message input box.

## Context

The composer sits inside `ThreadPrimitive.ViewportFooter` in `src/components/assistant-ui/elements/thread.aui.tsx`, after `ChatErrorBanner`. `src/ui/composer-controls.tsx` establishes the visual language for composer-adjacent controls: 7-unit-high pill triggers, `font-mono` labels, the `paper-sunk`, `rule`, and `accent` tokens, and micro labels. Phase 1 supplies `totalTokensOf`, `contextTokensOf`, and the transient `liveStats`; Phase 2 supplies `resolveContextCap`.

## Files to Create / Modify

- Create: `src/ui/context-meter-view.ts`
- Create: `src/ui/context-meter-view.test.ts`
- Create: `src/ui/context-meter.tsx`
- Create: `src/ui/context-meter.test.tsx`
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`

## Implementation Steps

1. In `src/ui/context-meter-view.ts`, put the derivation and formatting in pure functions: total, context, percentage, threshold position, rate, and the estimate flag, mirroring the existing `plan-view.ts` split so the numbers are testable under the repository's `environment: "node"` vitest setup.
2. In `src/ui/context-meter.tsx`, subscribe to the active thread's messages, the live stats, and the vault settings, and derive total tokens, context tokens, the resolved cap, the used percentage, and the current rate.
3. Compute the rate as `liveStats.chars / 4` over elapsed seconds while a run is in flight, and as the last turn's `usage.outputTokens` over `durationMs` once it is idle. Mark a live or fallback number with a `~` prefix and a title explaining that it is an estimate.
4. Render one compact row: total tokens for the thread, a thin proportional bar with `context / cap` and the percentage, and the rate. Use the existing tokens and `font-mono` numerals; no new colors.
5. Tint the bar with the app's caution tone once the auto-compaction threshold is crossed, and show the threshold as a hairline tick so the user can see the trigger point.
6. Add a `Compact now` action on the right of the row that runs the same `/compact` path, disabled while a run is in flight.
7. Hide the whole row when the thread has no messages, so a new chat stays clean.
8. Mount it in `thread.aui.tsx` inside `ViewportFooter` immediately after the composer and after the queued-item list from Phase 5.

## Verification

- `pnpm exec vitest run src/ui/context-meter-view.test.ts src/ui/context-meter.test.tsx`
- `pnpm lint`

## Success Criteria

- [x] The row renders under the input box, and not at all for an empty thread.
- [x] Totals, percentage, threshold position, and rate are asserted as pure functions in `context-meter-view.test.ts` against a fixture thread.
- [x] The rate shows a live estimate during a run and the exact rate afterwards, and estimates are visibly marked.
- [x] The bar changes tint at the auto-compaction threshold and shows the threshold tick.
- [x] `Compact now` is disabled during a run and compacts the thread when idle.
