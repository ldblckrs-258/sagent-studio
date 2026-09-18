---
title: Planned encrypted vault + client-side RAG with TypeSafe
date: 2026-09-18
summary: Authored two sequential plans after a red-team pass found 8 Critical/High crypto and concurrency defects
---

# Planned encrypted vault + client-side RAG with TypeSafe

## What happened

Ran an `ak:brainstorm` session on a fully client-side RAG system in IndexedDB, then
authored the core-infra plan under `ak:plan` with a three-reviewer red-team gate.

Brainstorm outcome: retrieval can stay entirely client-side, but TypeSafe and the LLM
provider are remote APIs, so "fully client-side" holds for retrieval and storage only.
The vault (config, secrets, content, vectors) is encrypted at rest with a user password.

Two plans were created:

- `plans/260918-1209-core-infra-vault` — 3 phases, ready.
- `plans/260918-1210-rag-typesafe-pipeline` — blocked stub, phases authored after Plan 1.

## Red-team findings applied (all 15 accepted)

The three reviewers (Security Adversary, Assumption Destroyer, Failure Mode Analyst)
raised defects that were grounded in real `file:line` evidence and would have shipped
broken:

1. Salt and iteration count were placed inside the encrypted blob — a bootstrap
   deadlock. Setup would succeed, then a reload could never derive the key, and a hard
   vault means permanent data loss. Moved to a plaintext `meta` record.
2. `createVault` wrote two records non-atomically under React 19 StrictMode, which
   double-invokes mount effects. Two salts, two keys, one disk record. Made atomic with
   an in-transaction re-check plus a module-scope in-flight guard.
3. `update(patch)` was an unserialized read-modify-write with three independent writers
   in Phase 3. Added a write queue with deep merge.
4. `lock()` could null the key mid-`update()`. `lock` now drains the queue; `update`
   captures the key before any `await`.
5. Every GCM tag failure reported "wrong password", making corruption indistinguishable
   from a typo. Added a canary blob and a recovery screen.
6. Provider secrets would render into DOM inputs, contradicting the plan's own success
   criterion. Added a masked reveal-on-demand field.
7. Keys live in browser memory with no CSP. Added a strict CSP and a no-`dangerouslySetInnerHTML`
   rule for the RAG handoff.
8. The "Argon2 swap behind the same KDF interface" claim was fictional. `KdfParams` is
   now a discriminated union and the claim is recorded as a migration, not a swap.

Plus High findings: AAD record binding, `navigator.storage.persist()`, `unlockGeneration`
client-cache invalidation, pinned TypeSafe `logLevel: 'warn'` (the SDK logs unredacted
request bodies at debug), `assertSubtle` on every crypto export, an `ErrorBoundary` +
`unhandledrejection` listener, and a frozen-interface block with real test infra
(`vitest`, `vitest/globals` types, `fake-indexeddb`).

## Verified corrections

- `@typesafe-ai/sdk` publishes `dist/` only; the browser guard citation was corrected
  from a non-existent `src/client.ts` to `dist/index.mjs:511`.
- `@ai-sdk/openai-compatible@3.0.52` declares provider-utils `5.0.44` while installed
  `ai@7.0.105` resolves `5.0.43` — one minor of drift, so the package is pinned exactly.
- `tsconfig.app.json` sets `verbatimModuleSyntax` and `erasableSyntaxOnly`, and
  `pnpm build` runs `tsc -b` over test files too. The plan now specifies `import type`
  and string-literal unions instead of `enum`.

## Decision

Two sequential plans, core infrastructure first, with Plan 2 kept as a blocked stub so
the dependency is visible. Plan 1 effort raised from 14h to 22h to cover the added
crypto, concurrency, CSP, and test-infrastructure work.

## Next steps

- `git init` before Phase 1 (the workspace has no version control).
- Execute `plans/260918-1209-core-infra-vault/plan.md` via `/ak:cook`.
- Phase 3's browser `systemOne` smoke test is the load-bearing gate for Plan 2; if it
  fails, Plan 2 must be re-scoped against a server proxy.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
