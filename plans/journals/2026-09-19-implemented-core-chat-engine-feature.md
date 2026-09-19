---
title: Implemented core chat engine feature
date: 2026-09-19
summary: "Executed all six phases of the core chat engine plan; vault record refactor, browser-verified sandbox runners, and review-found defects fixed"
---

# Implemented core chat engine feature

## What happened

Executed `plans/260919-0828-core-chat-engine/plan.md` end to end, all six phases, through `/ak:cook`. Scope was a UI-agnostic chat core under `src/chat`, `src/skills`, `src/tools`, `src/workspace`, and `src/sandbox`; no product UI in this plan.

- Phase 1 - worker runtime spike (browser-verified).
- Phase 2 - vault refactor to support encrypted records.
- Phase 3 - engine, reducer, persistence.
- Phase 4 - workspace and local-folder tools.
- Phase 5 - sandbox runners, browser-verified.
- Phase 6 - composition.

## Vault refactor

- `src/vault/keyring.ts` is now the single owner of key + generation; `unlockGeneration` is a projection, not a second source of truth.
- `src/vault/records.ts` adds `encryptRecord`/`decryptRecord`, both re-checking a keyring snapshot so a record cannot be written or read against a stale key.
- One shared `vaultWriteQueue` for all encrypted writes.
- Dexie versions 2 to 4 add `threads`, `skills`/`tools`, and `fs` tables.
- `recover()` and `vaultInternals.reset()` now clear all record tables, not just settings.

## Browser validation (recorded in the plan's manual-validation journal)

- Phase 1 spike (HeadlessChrome/147, `vite preview`): a Vite-emitted same-origin worker runs `new Function` and WASM under the strict document CSP (`script-src 'self'`, no `unsafe-eval`), reaches the network (no-cors opaque and a CORS 200 from api.github.com), opens `sagent-vault`, and `Worker.terminate()` stops an infinite loop.
- Phase 5 (built + preview with a temporary spike entry): `run_js` print+return; infinite loop gives `SandboxTimeoutError`; JS workspace write/read via the bridge; `../escape` rejected; `run_python` print+return; Python read/write through the RPC bridge; Python timeout followed by a successful second run after respawn.
- Worker chunks are emitted only when the runners are in the module graph (`dist/assets/js-worker-*.js`, `py-worker-*.js`); a plain app build emits neither.
- `vite.config.ts` adds `worker-src 'self'` and `worker: { format: 'es' }`, and documents the worker-CSP fact and the accepted residual egress risk.

## Review findings

An independent code review found one high-severity defect and three medium findings; all fixed with regression tests:

1. A pre-stream failure left an orphaned empty assistant placeholder that later turns persisted. The base history is now restored and persisted before rethrow.
2. `PyRunner` concurrent runs cross-attributed state. Runs are now serialized.
3. `providerOptions` was validated but never forwarded. It now reaches `streamText`.
4. One malformed workspace `SKILL.md` aborted the whole listing. Bad skills are now skipped per skill.

Also added `ToolRegistry.hydrate`, stricter persisted http-definition validation, and a test asserting the model id and provider options reach the model.

## Gates

- `pnpm test`: 268 tests / 28 files pass.
- `pnpm lint`: clean.
- `pnpm build`: clean.

Two gates could not be verified in this environment:

- Phase 4 Chromium folder picker + reload re-grant needs a real user gesture and a native dialog; headless CDP cannot drive it.
- Phase 6 real-provider turn needs a live API key.

## Deferred

- Phase 4 folder picker + reload re-grant, manual Chromium session.
- Phase 6 real-provider turn, needs a live provider key.

> Historical work record - not durable authority. Prefer docs/specs/ADRs for current decisions.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
