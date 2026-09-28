---
title: Code review — personal memories
date: 2026-09-28
plan: ../260927-2359-personal-memories/plan.md
score: 8/10
---

# Code review — personal memories

Transcribed by the lead from the code-reviewer subagent's reply (the subagent has no write tool).

## Outcome

- Score 8/10. No critical defects, no regressions found in the touchpoints.
- Gates (project TypeScript 6.0.3): `pnpm exec tsc -b` exit 0, `pnpm lint` exit 0, `pnpm exec vitest run` 147 files, 1774 passed, 1 skipped (pre-existing `it.runIf(typeof Worker…)`).
- Acceptance criteria 1–10 met. Criterion 6 caveat: `forget` has no keyring guard (S7); clear-on-dispose is wired but untested (W5).

## Approvals panel verdict

Not a defect against criterion 9: memory tools run without a prompt and a persisted `deny` blocks them, both tested. It is a gap against the plan's intent: there is no UI to set that `deny` (W3).

## Warnings

1. **Unicode line separators bypass the prompt hardening.** `src/chat/context.ts` `quoteBody` splits only `\r\n|\r|\n`; `normalizeTitle` rejects only `[\r\n]`; `clampIndexText` does not collapse U+0085. U+2028, U+2029, `\v`, `\f`, U+0085 survive inside one `> ` line. Fix: split on `/\r\n|[\n\r\v\f\u0085  ]/`, reject the same set in titles, add a test.
2. **Two tabs can detach a folder's memories.** `src/memory/state.ts` `dropScopeIfUnused` deletes a handle based on this tab's in-memory list, so tab B can remove a handle tab A just used. Fix: leave handle cleanup to `hydrate`, or list persisted memories before deleting.
3. **No user switch to stop memory writes.** `src/ui/panels/approvals.tsx:28` lists only gated tools. Options: keep the README note; list the three write tools with Allow/Deny; or a Memory-panel toggle that stores `deny`.
4. **Four tool names are now reserved.** `src/tools/registry.ts:62` skips a saved user tool whose name matches a provider, so a user tool named `remember`, `update_memory`, `forget`, or `recall_memory` disappears silently. The mechanism predates this feature.
5. **Session wiring is untested.** Removing `memory: memoryPortFor` from `src/session/session.ts` still passes the suite. Add a `session.test.ts` case.

## Suggestions

- S1 `state.ts`: `before` generation is read when a queued write starts, not when it is queued.
- S2 `state.ts`: `hydrate` is not serialized with writes; its handle cleanup can race a fresh-scope claim.
- S3 `port.ts`: the visibility check runs outside the store's write queue.
- S4 `context.ts`: important entries cut by the 4,000-character guard vanish entirely.
- S5 `state.ts`: `findScope` returns the first match; a folder with two scopes hides the second.
- S6 `tool-view/helpers.ts`: add a `memory_full` label.
- S7 `store.ts`: `removeMemory` has no keyring guard (same as `removeSkill`).
- S8 `state.ts`: `ensureScope` is used only by tests.
- S9 `ui/panels/memory.tsx`: `scopeIdOf` and `newestFirst` duplicate `state.ts` helpers.
- S10 no Dexie v6→v7 upgrade test (gap pre-exists for earlier versions).
- S11 `tools/builtin/memory.ts`: add `maxLength` to the title and body schemas.

## Follow-ups outside this change

- `recover()` and `reset` never clear `db.journals` (`src/vault/store.ts`); pre-existing.
- `plans/reports/researcher-260928-0511-mcp-browser-client-sdk.md` is unrelated; keep it out of this commit.
- `plan.md` and phase files still say `status: pending`.

## Unresolved questions

- Which fix for W3?
- Fix the two-tab handle bug (W2) now, given two-tab sync is a non-goal?
