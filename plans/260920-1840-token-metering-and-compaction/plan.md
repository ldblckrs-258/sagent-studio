---
title: "Token metering, compaction, slash commands, and message queue"
description: "Meter token usage and speed per thread, add a reusable slash surface where /compact and every installed skill share one namespace, auto-compact at a configurable cap, and queue messages typed during a run."
status: done
priority: P1
effort: "3d"
branch: main
tags: [feature, frontend, chat]
blockedBy: []
blocks: []
created: 2026-09-21
---

# Token metering, compaction, slash commands, and message queue

## Overview

The harness runs `streamText` with no usage accounting, so a thread can grow past the model's context window with no warning and no way to recover. This plan adds per-thread token accounting, a live tokens-per-second readout, a reusable slash-command surface, on-demand and automatic compaction, and a message queue so the composer stays usable while a run is streaming.

Compaction is non-destructive. A compaction boundary message carries the summary; the stored thread keeps every message, and only the summary plus everything after the boundary is sent to the model. The thread's own provider, model, and params produce the summary.

The slash surface is a registry, not a special case for one command. Built-in commands and installed skills share one namespace: the suggestion list shows `/compact` followed by every globally enabled skill, and `/<skill-id>` enables that skill for the thread and appends a hidden directive telling the model to call `load_skill` with that id immediately. The skill body never enters the conversation directly; it arrives through the existing tool path only when the model loads it. Adding a built-in command later is a registry entry plus its handler, with no composer or runtime changes.

The message queue is a library feature rather than new code: `@assistant-ui/core@0.3.19` ships `createMessageQueue` and the external-store `queue` adapter, `ComposerPrimitive.Queue` renders pending items, and the composer already unlocks Enter during a run when `capabilities.queue` is true.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Record per-turn token usage and stream timing on each assistant message | P1 |
| 2 | Show thread total tokens, context used against the cap, and tokens/s below the composer | P1 |
| 3 | Provide a reusable slash-command registry with a suggestion popover in the composer | P1 |
| 4 | Compact a thread on demand with `/compact [instructions]` | P1 |
| 5 | Invoke a skill as `/<skill-id>`, which enables it and directs the model to `load_skill` it at once | P1 |
| 6 | Auto-compact when context reaches a configurable share of a configurable cap | P1 |
| 7 | Queue messages typed during a run and dispatch them in order once it settles | P1 |

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Compaction shape | Boundary marker, full history retained | Reversible, keeps the UI transcript intact, no destructive rewrite of persisted threads |
| Cap configuration | Global setting with per-thread override | `model-catalog.ts` exposes model IDs only, with no context-window metadata, so the cap must be user-supplied; threads may use different models |
| Token source | Provider usage first, local estimate fallback | OpenAI-compatible servers often omit usage; auto-compaction must still work, and estimates are labeled in the UI |
| Speed readout | Live estimate during the stream, exact rate at finish | Live number comes from text-delta characters; the exact number comes from `usage.outputTokens` over the stream duration |
| Summarization model | The thread's own provider, model, and params | No second provider to configure, and the summary matches the thread's model family |
| Slash registry | Own registry in `src/chat/slash.ts`, consumed by both the composer UI and the send path | Reusable for future commands, and the same parse runs for a queued command that dispatches later |
| Skills in the slash namespace | Skills are registry entries alongside built-in commands, filtered to globally enabled ones | Matches how `ComposerControls` already gates skills, and keeps one list for the user to search |
| Skill invocation shape | Enable the skill on the thread, then append a short hidden directive to call `load_skill` | Costs a couple of tokens instead of a whole instruction body, and the body enters context only when the model actually loads it |
| Enablement is required, not optional | `/<skill-id>` adds the ref to `config.enabledSkills` | `createSkillLoadPort` resolves only `config.enabledSkills`, and `load_skill` joins the tool set only when that list is non-empty, so a directive without enablement would resolve to null |
| Duplicate skill ids | An unsuffixed name resolves to the vault skill; the workspace one needs `@workspace` | A skill is keyed by `source:id`, so the same id can exist twice, and the trusted source is the safer default |
| Slash suggestion UI | Hand-built popover over Radix `Popover`, already a dependency and already used by `composer-controls.tsx` | `unstable_useSlashCommandAdapter` is marked unstable and its `ComposerTriggerPopover` companion is not exported by this version |
| Queue | `createMessageQueue` + external-store `queue` adapter | Already implemented upstream, including the steer lane, cancel handling, and item primitives |

## Phases

| # | Phase | Status | Depends on |
|---|-------|--------|------------|
| 1 | [Phase 1: Usage capture and token accounting](./phase-01-usage-accounting.md) | Done | — |
| 2 | [Phase 2: Context cap settings](./phase-02-context-settings.md) | Done | — |
| 3 | [Phase 3: Compaction core and auto-compact](./phase-03-compaction.md) | Done | 1, 2 |
| 4 | [Phase 4: Slash command registry and suggestion UI](./phase-04-slash-registry.md) | Done | 3 |
| 5 | [Phase 5: Message queue](./phase-05-message-queue.md) | Done | 4 |
| 6 | [Phase 6: Context meter UI](./phase-06-context-meter.md) | Done | 1, 3, 5 |

Phases 1 and 2 are independent and may run in parallel. Phases 3 through 6 are sequential.

## Architecture

```
composer input ──▶ SlashSuggestions (registry.match on the composer text)
        │ send
        ▼
   queue adapter (createMessageQueue)
        │  run(message)
        ▼
   runSlashOrSend ──/compact──────▶ compactThread ──▶ boundary message
        │           ──/<skill-id>──▶ enable skill + load_skill directive (+ trailing text, then run)
        │ plain text
        ▼
   engine.sendTurn ──▶ startRun
                         │ contextTokensOf >= cap * ratio ?
                         │        yes ──▶ compactThread first
                         ▼
                    buildRunStream
                         │ messagesSinceBoundary(messages)
                         ▼
                     streamText ──▶ toUIMessageStream({ messageMetadata })
                         │                    │
                         │                    └─▶ metadata.usage on the assistant message
                         ▼
               readUIMessageStream loop ──▶ liveStats (chars, elapsed) in useChatStore
                                                │
                                                ▼
                                      ContextMeter under the composer
```

## Files

| Action | Path | Purpose |
|---|---|---|
| Create | `src/chat/usage.ts` | Usage types, token estimation, context and total derivation |
| Create | `src/chat/usage.test.ts` | Unit tests for estimation and derivation |
| Create | `src/chat/boundary.ts` | Boundary geometry, shared by `usage.ts` and `compact.ts` |
| Create | `src/chat/compact.ts` | Summarization and the boundary append |
| Create | `src/chat/compact.test.ts` | Unit tests for slicing, boundary handling, failure rollback |
| Create | `src/chat/slash.ts` | Entry registry, parsing, matching, `/compact` definition |
| Create | `src/chat/slash.test.ts` | Parser, matcher, and handler tests |
| Create | `src/chat/skill-invoke.ts` | Directive message construction and the invoke handler |
| Create | `src/chat/skill-invoke.test.ts` | Enablement, directive ordering, and no-duplicate-ref tests |
| Create | `src/chat/queue.ts` | Queue driver that routes a dispatched message through the slash registry |
| Create | `src/chat/queue.test.ts` | Dispatch order, cancel-holds-queue, slash-in-queue tests |
| Create | `src/ui/slash-suggestions-state.ts` | Pure filtering, highlight, and completion logic |
| Create | `src/ui/slash-suggestions-state.test.ts` | Tests for that logic under the node test environment |
| Create | `src/ui/slash-suggestions.tsx` | Composer-anchored suggestion popover driven by the registry |
| Create | `src/ui/slash-suggestions.test.tsx` | Static-markup test for the open list |
| Create | `src/ui/context-meter-view.ts` | Pure derivation and formatting of the meter values |
| Create | `src/ui/context-meter-view.test.ts` | Tests for totals, percentage, threshold, and rate |
| Create | `src/ui/context-meter.tsx` | Token, context, and speed readout |
| Create | `src/ui/context-meter.test.tsx` | Static-markup rendering test |
| Modify | `src/chat/engine.ts` | Usage metadata, stream timing, boundary slicing, auto-compact hook |
| Modify | `src/chat/store.ts` | Transient per-thread live stream stats |
| Modify | `src/chat/sanitize.ts` | Extend `ChatMessageMetadata` with usage and compaction |
| Modify | `src/chat/types.ts` | Optional per-thread `maxContextTokens` |
| Modify | `src/chat/use-chat-runtime.ts` | Slash routing on send, queue driver, queue adapter wiring |
| Modify | `src/vault/settings.ts` | `context` settings block, defaults, validation |
| Modify | `src/components/assistant-ui/elements/thread.aui.tsx` | Mount suggestions, queued items, and the meter around the composer |

## Success Criteria

- [x] An assistant message carries `metadata.usage` after a run, and the value survives a reload.
- [x] The readout under the composer shows thread total tokens, context used against the cap with a percentage, and tokens/s that is live during a run and exact at finish.
- [x] Estimated numbers are visibly marked as estimates when the provider omits usage.
- [ ] Typing `/` in the composer opens a suggestion list from the registry, arrow keys and Enter select, Escape dismisses, and selecting completes the command text.
- [x] The suggestion list shows `/compact` plus every globally enabled skill, with a source tag for workspace skills.
- [x] `/<skill-id>` adds the ref to `config.enabledSkills` without duplicating it, and the run's skill port then resolves that id.
- [x] `/<skill-id>` with no trailing text appends only the directive and starts no run; `/<skill-id> <text>` appends the directive, then the text, and starts one run in that order.
- [ ] A message carrying `skillDirective` renders as a one-line marker rather than a chat bubble.
- [x] Adding a new built-in command requires only a registry entry and a handler, with no edits to the composer or the runtime.
- [x] `/compact` appends a summary boundary, the UI keeps the full transcript, and the next turn answers coherently from the summary.
- [x] A failed summarization leaves the thread unchanged, surfaces the error, and does not lose the user's pending message.
- [x] Auto-compaction fires when context reaches `cap * ratio`, does not fire on approval-resume runs, and is disabled by `autoCompactEnabled: false`.
- [x] The cap resolves from the thread override first and the global setting second.
- [x] Typing Enter during a run queues the message, queued items render under the composer and can be removed, and they dispatch in order once the run settles.
- [x] A queued `/compact` runs in order when it reaches the front of the queue.
- [x] Cancelling a run holds the queue instead of draining it.
- [x] `pnpm test` and `pnpm lint` pass.

## Risks

| Risk | Mitigation |
|---|---|
| Summarization call fails or is aborted | Compaction is transactional: the boundary is appended only on success; on failure the thread is untouched, the error goes to the chat error banner, and a queued turn stays queued |
| Provider omits usage, so the cap check drifts | Estimate fallback labeled in the UI; the estimate is derived from the same serialized messages the request sends |
| `messageMetadata` merge clobbers `chatStatus` | Covered by a test asserting both `chatStatus` and `usage` survive a full stream |
| Auto-compaction during an approval resume corrupts the paused tool call | Auto-compaction is skipped whenever `startRun` is called with `resumeAssistantId` |
| Enabling a skill narrows the tool set through its `allowedTools` | That is the existing meaning of enabling a skill; the phase states it so the behavior is chosen rather than discovered, and the suggestion list shows only globally enabled skills |
| The model ignores the directive and never calls `load_skill` | The skill is enabled either way, so its index entry is in the system prompt and the model can still load it on demand |
| Hand-built suggestion popover fights the composer's own Enter handling | The popover owns Enter only while it is open and has a highlighted item, and it never renders while the composer text has no leading slash |
| Vitest runs with `environment: "node"`, so DOM interaction cannot be tested in a component test | Interaction and formatting logic lives in pure modules beside the components, matching the existing `plan-view.ts` and `resize.ts` split |
| Queued items are lost on reload | Accepted: the queue is in-memory only, which the plan states explicitly |

## Out of scope

- Cost or pricing display.
- A model context-window catalog or auto-detected caps.
- Persisting queued messages across a reload or thread switch.
- Built-in commands beyond `/compact`; the registry exists so later ones are additive.
- Changing what enabling a skill means, or broadening `load_skill` to resolve skills the thread has not enabled.

## Verification notes

`pnpm test` (948 passed, 1 skipped), `pnpm lint`, and `pnpm exec tsc -b --force`
all pass. The unticked criteria are the ones no automated test can reach in this
repository, because vitest runs with `environment: "node"` and components are
asserted through `renderToStaticMarkup`:

- Opening the popover by typing `/`, and arrow, Enter, Tab and Escape handling,
  are covered as pure functions in `src/ui/slash-suggestions-state.test.ts`. The
  keydown interception itself (a capture handler wrapping
  `ComposerPrimitive.Input`) has no test and needs a pass in the running app.
- The one-line marker for a `skillDirective` message is rendered in
  `thread.aui.tsx`, which has no test file; the metadata that drives it is
  asserted in `src/chat/skill-invoke.test.ts` and `src/chat/convert.ts`.
- Queued items rendering under the composer relies on
  `ComposerPrimitive.Queue`; the queue's ordering, cancel-hold, removal and
  clear-on-switch behavior is asserted in `src/chat/queue.test.ts`.
- "The next turn answers coherently from the summary" is a model-quality
  outcome, not a testable assertion. What is asserted is that the request
  carries only the boundary and later messages.

## Deviations from the plan as written

| # | Deviation | Why |
|---|---|---|
| 1 | `/compact` calls a new `ChatEngine.compact(threadId, instructions?)` instead of `compactThread` directly | The UI has no `PipelineDeps`, and a second writer would fork the thread persistence path |
| 2 | The queue driver omits `cancel` | With `cancel`, the library's steer lane aborts the running turn and dispatches at once, contradicting three of Phase 5's own success criteria. Omitting it gives FIFO ("steering degrades to process next"). Cost: a pending item cannot be promoted to run now |
| 3 | Auto-compaction splits off the trailing user turn (`splitTrailingUserTurn`) and re-attaches it after the boundary | `startRun`'s base array ends with the pending question; a boundary appended past it would make `messagesSinceBoundary` return the summary alone and drop the question |
| 4 | The global `context` block is normalized tolerantly in `migrate`; only the per-thread override rejects | An invalid block in a hand-edited vault must not make the vault unlockable. `validateContextSettings` throws with a clear message and is what `migrate` calls |
| 5 | `slash-suggestions.tsx` and `context-meter.tsx` import `../lib/utils`, not `@/lib/utils` | `vitest.config.ts` declares no `@` alias, so an aliased import is not importable from a test |
| 6 | A `maxContextTokens` field was added to the Thread config form in `src/ui/panels/chat-config.tsx` | Phase 2 step 4 adds the override to `ConfigDraft` "so the Thread config form can set an override"; without an input the override is unreachable |

## Review findings fixed after implementation

A fresh-context review found three blockers, each confirmed against the real
library or the real engine before it was fixed, and each now covered by a test
that fails against the previous code.

| # | Defect | Fix |
|---|---|---|
| 1 | `finish.totalUsage.inputTokens` is the **sum of every model step's prompt**, so a turn counted the same conversation once per tool call. With `stopWhen: () => false` and tool loops, a six-call turn reported roughly six times the true context and tripped auto-compaction on a short thread | `TurnUsage` gained `contextTokens`, recorded from the last `finish-step`'s own usage. `totalTokens` and the rate still come from `totalUsage`. Verified against the real stream: `start` fires once per turn, `finish-step` once per step |
| 2 | `contextTokensOf` estimated over the **whole thread**, so a compacted thread still reported its pre-compaction size. Compaction never lowered the number that triggered it, and every later turn paid for another summarization call | It now measures over `messagesSinceBoundary`, matching what the request actually sends. `boundary.ts` was extracted so `usage.ts` can slice without a cycle |
| 3 | The queue tracked busy from the store's run count alone. Any dispatch that finishes **without starting a run** — `/compact`, a bare `/<skill-id>`, an unknown command, or a pre-run failure — left the count untouched, so the queue stayed "running" forever and every later message was stranded | Busy is now the union of the store's count and the queue's own in-flight dispatch, notified on the edge. The store is still consulted so a rerun or approval resume is not interrupted |

### Majors and minors also fixed

| # | Defect | Fix |
|---|---|---|
| 4 | Any leading `/` was routed to the registry, so `/tmp/foo is missing` failed to resolve and the text was gone — the composer clears its draft before the send resolves, and the driver swallowed the error so no restore was attempted | `looksLikeSlashCommand` requires a single unbroken name token, so prose with an inner slash sends normally. A genuine typo still errors, and the error now carries the unsent text |
| 5 | The external-store runtime does not subscribe to the queue, so removing a pending item did not repaint | `ChatQueue.subscribe`, turned into a render by a reducer in `useChatRuntime` |
| 6 | The pending-item reset was keyed to `activeThreadId`, which moves from `null` to its id on the first send of a session; a message typed during that round trip was dropped | Reset only on a real thread-to-thread change, tracked in a ref |
| 7 | `engine.compact` was uncancellable, had no in-flight-run guard, and wrote the whole thread object from a pre-await snapshot | Registered like a run so `cancel` and `dispose` abort it, refuses while a run is in flight, and writes only the messages array |
| 8 | `this.runs.set` happened after the auto-compaction await, so for the length of a model round-trip a concurrent `startRun` aborted one controller but awaited the previous run's promise | The whole run body, compaction included, is inside the promise that is registered before any await |
| 10 | A provider reporting only `totalTokens` was treated as unmeasured, discarding a real number in favour of an estimate | `totalTokens` now counts as measured |
| 11 | The suggestion popover claimed Enter and Tab unconditionally, so Shift+Enter could not insert a newline and the steer hotkey could not fire while the list was open | Modifier and IME guards before a completion is taken |
| 12 | `invokeSkill` did not handle `VaultLockedError`, surfacing a raw vault failure instead of dropping the thread | Matches the engine's own persist path |
| 15 | A boundary rendered as an ordinary assistant bubble, whose Regenerate drops it and silently un-compacts the thread | `compaction` is forwarded alongside `skillDirective` and rendered as a collapsible marker with no message actions |
| 18 | On a resumed run the live rate counted text the message already held | The starting character count is subtracted |
| 20, 21 | A successful compaction cleared an unrelated error banner; the meter duplicated its visibility guard | Both removed |

### Left open deliberately

- **Finding 9** (a request window beginning with an assistant message may be rejected by an Anthropic-compatible proxy) — unverified against a live endpoint, and it changes what the model sees. Worth deciding before anyone points `baseURL` at such a proxy.
- **Findings 16, 17** (no UI for the global `context` block; `useVaultStore.update` does not validate it) — no current writer, and consistent with the repo, which has no panel for `idleLockMinutes` either.
- **Finding 14** (`onNew` is unreachable now that a queue is always supplied) — left in place rather than risk changing the runtime's capability detection.
- **Finding 19** noted in `boundary.ts`: a skill directive is a user message, so `splitTrailingUserTurn` carries it past the boundary, which is required for the model to see it.

### A verification note worth keeping

`tsc -b` writes its build info to `node_modules/.tmp/`. A stale file there made
one `--force` run report 26 phantom errors in files the change never touched.
The state was confirmed clean by clearing the build info and by type-checking a
pristine `HEAD` worktree for comparison. Piping `tsc` or `eslint` into `tail`
also hides their exit status, so the gates are worth running bare.
