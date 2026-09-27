---
phase: 2
title: Child context compaction
item: A2
status: completed
---

# Phase 2 — Child context compaction

## Goal

A long child run never hits the provider's context limit because of its own
history. Old steps are summarized between steps, and the user sees when that
happened and how full the context is.

## Files

- Add: `src/agents/compaction.ts`, `src/agents/compaction.test.ts`
- Modify:
  - `src/chat/compact.ts`: extract a model-level summarizer; parent behavior is
    unchanged.
  - `src/agents/runner.ts`, `src/agents/run-transcript.ts`
  - `src/agents/store.ts`: `contextTokens`.
  - `src/ui/agent-run-view.tsx`: the meter.
  - Tests.
- Read first:
  - `src/chat/compact.ts`
  - `src/chat/context-cap.ts`: `resolveContextCap`, `shouldAutoCompact`,
    `autoCompactThreshold`.
  - `src/ai/model-tier.ts`: tier to provider/model.
  - `src/ui/compaction-indicator.tsx`, and `CompactionMarker` in `thread.aui.tsx`.

## Steps

1. In `compact.ts`, extract `summarizeModelMessages(model, messages:
   ModelMessage[], params, signal)`, which reuses `SUMMARY_SYSTEM`.
   `summarizeMessages` calls it, with no change for the parent.
2. In `src/agents/compaction.ts`, add the pure helpers:
   - `safeCutIndex(messages)`: the largest index `k` that keeps at least the last
     2 exchanges and never separates an assistant tool call from its tool result.
     Cut only before a `user` message or right after a `tool` message.
   - `compactPrefix(messages, summary)`: returns `[{ role: 'user', content:
     '<earlier-work-summary>…</earlier-work-summary>' }, ...messages.slice(k)]`.
3. Runner:
   - Resolve the cap from the tier's provider/model:
     `resolveContextCap(settings, { providerId, modelId })`.
   - Track `lastInputTokens` from `finish-step` usage and store it as the
     record's `contextTokens`.
   - In `prepareStep`, after steering is applied, check
     `shouldAutoCompact(lastInputTokens, cap)` and whether a safe cut exists. If
     both hold, summarize `messages.slice(0, k)` with the child's model and
     return the compacted list.
   - The override carries forward to later steps (verified), so each prefix is
     compacted once.
   - Across passes, set `history` to the compacted list plus the pass's
     responses, so the next pass starts from the summary.
   - If the summary fails, log it into the run (a transcript marker with the
     error) and continue uncompacted, matching the parent's policy.
4. Transcript: record `pass.compactions.push({ step, tokensBefore })`.
   `passMessages` inserts a boundary message with `metadata.compaction`, which
   `ThreadMessage` already renders as `CompactionMarker`, at that step's offset.
   It must not be counted as an assistant segment for tools.
5. Run view header: a context meter of the form `ctx 45k / 200k` from
   `record.contextTokens` and the cap. Reuse `context-meter-view.ts` formatting
   if it fits.

## Tests (intent)

- `safeCutIndex` never returns an index between a tool call and its result.
  Check across tool-heavy, text-only, and single-exchange histories.
- When the mock model reports `inputTokens` over the threshold on step N:
  - one summary call happens;
  - step N+1's prompt starts with the summary and lacks the replaced messages;
  - step N+2 does not summarize again unless the threshold is crossed again.
- With `autoCompactEnabled: false`, no summary call happens.
- A failed summary still finishes the run and leaves a marker.
- The transcript shows the compaction marker between the right segments.

## Risks

- Token counts come from the provider's `inputTokens`. When a provider does not
  report them, fall back to `estimateTokens` over the serialized messages.
