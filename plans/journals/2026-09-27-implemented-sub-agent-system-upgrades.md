---
title: Implemented sub-agent system upgrades
date: 2026-09-27
summary: "Nine-phase sub-agent upgrade landed uncommitted; review caught a last-step history loss and a continue race, both fixed with mutation-checked tests."
---

# Implemented sub-agent system upgrades

## What happened

Plan `260927-2137-subagent-system-upgrades` is fully implemented, but not yet committed. It adds:

- a child prompt contract;
- child context compaction;
- `outputSchema` structured results;
- agent profiles (built-ins plus `.agents/agents/*.md`);
- continue and resume (`message_agent`, plus a composer and a Resume action in the run view);
- `wait_agents` fan-out and gather;
- an auto-continue setting (off by default, cap 3);
- per-run file changes and revert.

Gates pass:
- tests: 1708 pass and 1 is skipped (the baseline was 1586);
- `pnpm exec tsc -b`: clean;
- `pnpm lint`: clean.

The build and browser check were skipped at the user's request.

## Root causes found in review

- **The final step was dropped from history.** The runner rebuilt a pass's history as `stepMessages + response.messages.slice(stepResponses)`. In AI SDK 7, `result.response.messages` holds only the final step, so that slice was empty and the child's final report went missing. This broke structured extraction and the next pass after a steer.
  - **Fix:** `history = [...stepMessages, ...messages]`.
- **Continue could orphan a run.** `continue` checked the limits and the live controller, then awaited the persistence load, the profile refresh and `portsFor`, and only then registered. Two parallel continues of one run started two streams, one of which nothing could stop.
  - **Fix:** a synchronous `reserved` slot that `limitFor` counts.
- **Smaller fixes:**
  - An aborted `wait_agents` now delivers the notices of runs that settled while it waited, before its first await.
  - Journal eviction now marks a run's revert `expired` and its file list `filesChangedIncomplete`.
  - Compaction falls back to an estimate when the provider omits usage.
  - A notice that arrives while a turn is paused on an approval is anchored inside that message, so the approval stays answerable.
- Each fix has a test that was confirmed to fail on the old code.

## Decisions

- **Profile mode.** A profile's mode is a default; an explicit mode can override it, but the parent's mode still caps it.
- **Revert code.** `applyRunRevert` stays separate. It will be merged onto message-rewind's `applyRestore` once that lands.
- **Tool ceiling.** `message_agent` and `wait_agents` share the read-only ceiling with `spawn_agent`.

## Environment

A parallel message-rewind session edited several of the same files in this working tree:
- `journal.ts` and `journal-io.ts`;
- `history.ts`;
- `engine.ts` and `engine.test.ts`.

A commit therefore needs care: `journal.ts`, `engine.ts` and `engine.test.ts` each hold changes from both workstreams.

The RTK hook's global TypeScript 5.x reports false errors. The project's TypeScript 6 build (`tsc -b`) is clean.

## Next steps

- Decide how to commit alongside the rewind work.
- Work through the follow-ups listed in `plan.md`, under "Execution notes".

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
