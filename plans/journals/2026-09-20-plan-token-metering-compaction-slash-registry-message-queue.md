---
title: "Plan: token metering, compaction, slash registry, message queue"
date: 2026-09-20
summary: "Planned per-thread token accounting, non-destructive compaction, a reusable slash-command surface, and an assistant-ui message queue."
---

# Plan: token metering, compaction, slash registry, message queue

## What happened

Scouted the harness before planning. `src/chat/engine.ts` runs `streamText` with `stopWhen: () => false` and converts through `toUIMessageStream`, with no usage accounting anywhere in the repo and no slash-command infrastructure. `src/ai/model-catalog.ts` discovers model ids only, with no context-window metadata, so a context cap cannot be inferred from the provider.

Two library findings changed the design. `toUIMessageStream` accepts `messageMetadata: ({ part }) => ...`, called on `start` and `finish`, and the `finish` part carries `totalUsage`, so per-turn usage rides on existing message metadata and needs no new persisted field. `@assistant-ui/core@0.3.19` already ships a message queue: `createMessageQueue`, the external-store `queue` adapter, `ComposerPrimitive.Queue`, and an Enter unlock in `ComposerInput` once `capabilities.queue` is true. The queue is therefore wiring, not new machinery.

A convention check caught a planning error before it shipped: vitest runs with `environment: "node"` and existing component tests use `renderToStaticMarkup`, so the originally planned keyboard-interaction component tests could not run. The plan now splits interaction and formatting into pure modules beside the components, matching the existing `plan-view.ts` and `resize.ts` pattern.

## Decision

Compaction is non-destructive: a boundary message holds the summary, the stored thread keeps every message, and only the summary plus later messages reach the model. The context cap is a global setting with a per-thread override, since threads can target models of different sizes. Token counts prefer provider usage and fall back to a labeled local estimate, because OpenAI-compatible servers often omit usage. Mid-plan the user asked for the slash mechanism to be reusable, so it became a registry plus a suggestion popover with `/compact` and `/skill` as its first two commands, built on Radix rather than the upstream `unstable_` slash adapter.

## Next steps

Execute `plans/260920-1840-token-metering-and-compaction/plan.md` with `/ak:cook`. Phases 1 and 2 are independent; 3 through 6 are sequential.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
