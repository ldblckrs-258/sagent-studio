---
title: Sub-agent tool results dropped in the live flow
date: 2026-09-23
summary: "Live Agents-panel sub-agent tool calls rendered empty because the live projection hardcoded output: {}; one-line fix plus regression tests."
---

**What happened.** Every tool call in the Agents-panel sub-agent flow rendered
with an empty body ("no result"). Only the live session was affected; after
reload the same calls showed real output.

**Root cause.** `uiMessagesFromEvents` in `src/agents/run-messages.ts` projected
live `tool-result` events into UIMessage parts with a hardcoded `output: {}`,
discarding `event.output`. Upstream was already correct: `src/agents/runner.ts`
emitted the real output and `src/agents/types.ts` typed it. Only the live
projection dropped it; the persisted transcript builder `src/agents/runtime.ts`
preserved it, which is why reload worked and the live run did not.

**Fix.** One line in `src/agents/run-messages.ts`:
`output: {}` -> `output: event.output ?? {}`.

`src/agents/run-messages.test.ts` had been asserting the buggy `{}`, so it stayed
green while the app was broken. Updated it and added regression tests in
`src/agents/run-messages.test.ts` and `src/ui/panels/agent-flow-view.test.tsx`;
both fail without the fix and pass with it.

**Gates.** `pnpm exec vitest run src/agents src/chat src/ui/panels` = 500 passed;
`pnpm lint` clean; `pnpm exec tsc -b` clean; `pnpm build` succeeded.

**Lesson.** The test encoded the bug: a fixture that omits the value under test
cannot detect its loss. Unfixed and out of scope: `transcript()` in
`src/agents/runtime.ts` seeds tool-call parts as `state: 'output-available'` with
`output: {}` before the result arrives, so a mid-run persisted snapshot can show
a still-running tool as done after reload (pre-existing, independent of this fix).

Status: DONE_WITH_CONCERNS
Summary: Found and fixed a one-line live-projection bug (`output: {}`) that hid all sub-agent tool results in the Agents panel; 500 tests, lint, tsc, and build green, with one pre-existing transcript-seeding concern left unfixed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
