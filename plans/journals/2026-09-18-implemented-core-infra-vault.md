---
title: Implemented the encrypted vault and SDK factories (Plan 1)
date: 2026-09-18
summary: Executed plan 260918-1209-core-infra-vault; an independent review caught a lock race, recovery dead-ends, and a canary error-masking bug before handoff
---

# Implemented the encrypted vault and SDK factories (Plan 1)

## What happened

Executed `plans/260918-1209-core-infra-vault/plan.md` end to end through
`/ak:cook` in auto mode, after `git init`. Three phases, all committed
separately so a botched phase could be reverted.

- Phase 1 — WebCrypto core: `randomBytes`, PBKDF2-SHA256 (600k) key derivation,
  AES-GCM-256 encrypt/decrypt, AAD record binding, typed errors, and the Vitest
  harness (`vitest`, `fake-indexeddb`, `vitest/globals` in `tsconfig.app.json`).
- Phase 2 — Dexie-backed encrypted settings store and vault shell: atomic
  first-run setup with an in-flight guard and an in-transaction re-check,
  canary-based wrong-password vs corruption detection, a serialized deep-merge
  write queue, idle auto-lock, and setup/unlock/recovery screens behind an
  error boundary.
- Phase 3 — Provider registry and SDK factories: `createLLM`, `createTypeSafe`
  (pinned `logLevel: 'warn'`), an `unlockGeneration`-keyed client cache, the
  masked reveal-on-demand secret field, the provider CRUD panel with a
  connection test, the data-egress notice, and a build-injected strict CSP.

Final state: 81 tests across 7 files, `pnpm lint` clean, `pnpm build` clean.

## What the review caught

An independent `code-reviewer` pass, given the plan's acceptance criteria and
the frozen interfaces, found defects that the implementing context had already
rationalized away. All were verified before fixing:

1. **Lock/update race.** `lock()` drained the write queue by snapshotting its
   tail, so an `update()` enqueued during the drain window escaped it. The key
   was nulled *after* the drain, so the write could still land — and the store
   could report `locked` while decrypted settings remained resident. Fixed by
   nulling the key synchronously first and binding each queued write to the key
   captured at enqueue time.
2. **Dexie open failure parked the app on "Loading…" forever.** The failure was
   caught and set `status: 'recovering'`, but never `presence`, and the render
   returned early on `presence === null`. Fixed by moving presence into the
   store and routing the failure through `refreshPresence()`.
3. **A benign `VaultLockedError` forced the erase-only recovery screen.** A
   debounced fire-and-forget write that lost a race with `lock()` was promoted
   by the global `unhandledrejection` listener. Fixed by special-casing it, and
   by catching the debounced writes.
4. **`recover()` left `presence` stale**, so the recovery screen could not exit
   and the first-run path fell back to an unlock form that could never succeed.
5. **`decryptCanary` masked every error as a wrong password**, including
   insecure-context and malformed-blob failures — the exact distinction the
   canary exists to make. Fixed to propagate them.
6. **The byte-scan acceptance test was vacuous.** It stringified records, and
   `JSON.stringify(Uint8Array)` emits an index map, so plaintext in a byte field
   was invisible. Rewritten to scan raw bytes.
7. **`__proto__` and non-object handling** in `deepMerge`/`migrate`, an
   unenforced `MAX_PROVIDERS`, and an unsurfaced `persistedStorage` denial.

## Design corrections during execution

- **CSP placement.** The plan specified a static `index.html` meta tag. In dev,
  `@vitejs/plugin-react` injects an inline Fast Refresh preamble, which a strict
  `script-src 'self'` blocks. Moved to a build-only Vite plugin so the policy
  applies to the production bundle and dev stays usable. Verified present in
  `dist/index.html` with no inline script remaining.
- **Wrong-password semantics.** The plan's Phase 1 step 9 said a bare tag failure
  should throw `WrongPasswordError`, but its acceptance criterion says a tampered
  blob should throw `CorruptVaultError`. A bare tag failure is genuinely
  ambiguous, so the disambiguation lives in the canary path and the low-level
  `decrypt` reports corruption.
- **PBKDF2 baseline.** ~74 ms at 600,000 iterations on this machine — far under
  the ~1 s threshold, so the iteration count was left alone.
- **Provider-utils drift** (5.0.43 vs 5.0.44) did not break the combined build.

## Honest gaps

Two plan acceptance criteria are not fully met and are checked off as pending,
not done:

- The live `systemOne` browser call needs a real TypeSafe key; none was
  available. The factory construction and `logLevel` pin are unit-tested.
- The CSP has only been verified in the built HTML, not in a running browser; no
  browser automation dependency is installed. This matters because Phase 3's
  risk table treats the browser gate as load-bearing for Plan 2.

Neither blocks Plan 2's interface work — the frozen interfaces (`VaultState`,
`createLLM`, `createTypeSafe`) are final and unchanged from the plan.

## Next steps

- Run the deferred `systemOne` browser smoke test with a real key and record the
  result in `plan.md`.
- Author Plan 2 (`plans/260918-1210-rag-typesafe-pipeline`) against the frozen
  interfaces, adding a browser test dependency if the CSP claim must be proven
  rather than asserted.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
