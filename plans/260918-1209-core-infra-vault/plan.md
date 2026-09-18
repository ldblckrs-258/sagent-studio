---
title: "Core Infrastructure + Encrypted Vault"
description: "Client-side crypto, encrypted settings store, and reusable SDK factories for the two upstream APIs"
status: pending
priority: P1
effort: 22h
branch: none
tags: [feature, frontend, security, infra]
blockedBy: []
blocks: [project:260918-1210-rag-typesafe-pipeline]
created: 2026-09-18
---

# Core Infrastructure + Encrypted Vault

## Overview

This plan builds the foundation the RAG pipeline depends on: a browser-native
cryptographic vault, an encrypted settings store, and two UI-agnostic SDK factories.
It starts from a bare Vite + React 19 + TypeScript template. When it completes, a
user can set a password, unlock the app, configure one or more LLM providers plus a
TypeSafe key, and obtain a working language model and TypeSafe client from those
settings — all persisted locally in encrypted form.

Retrieval, embeddings, and document indexing are deliberately out of scope; they
belong to the RAG pipeline plan, which consumes the interfaces built here.

Source of truth for the contract, verified environment evidence, and approach
comparison:
[`reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md`](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md).

## Current State (verified)

Inspected in this workspace, not assumed:

- `package.json`: Vite 8, React 19, TypeScript 6, Tailwind 4, React Compiler via
  Babel, ESLint 10, pnpm.
- Installed and usable: `dexie@4`, `ai@7`, `@ai-sdk/react`, `@typesafe-ai/sdk@0.6.0`,
  `zustand@5`, `motion`, `radix-ui`, `lucide-react`.
- **No LLM provider package installed.** `node_modules/@ai-sdk` contains only `react`.
- `ai@7` exports `customProvider` and `createProviderRegistry`;
  `@ai-sdk/openai-compatible@3.0.52` provides `createOpenAICompatible({ baseURL, name, apiKey })`
  with `.chatModel(modelId)`.
- `@typesafe-ai/sdk` exports `TypeSafeClient`, `choice`, `noul`, `score`.
- **No crypto dependency installed**; WebCrypto is native.
- **No test runner installed.** Vitest and `fake-indexeddb` must be added in Phase 1.
- **No git repository** and **no `docs/` directory** in this workspace.
- `TypeSafeClient` throws on construction in a browser unless
  `dangerouslyAllowBrowser: true` (verified at
  `node_modules/@typesafe-ai/sdk/dist/index.mjs:511`; the package publishes `dist/`
  only, so SDK source reading must target the bundled ESM).
- `tsconfig.app.json` sets `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `noUnusedLocals`, and `noUnusedParameters`, and `pnpm build` runs `tsc -b` over all
  of `src/`, including test files.

## Dependencies

| Relationship | Plan | Status |
| --- | --- | --- |
| Blocks | `project:260918-1210-rag-typesafe-pipeline` | pending |

No upstream blockers. This is the first plan in the sequence.

## Phases

| # | Phase | Status |
| --- | --- | --- |
| 1 | [Vault Crypto Core](./phase-01-vault-crypto-core.md) | Pending |
| 2 | [Settings Store + Vault Shell](./phase-02-settings-store-vault-shell.md) | Pending |
| 3 | [Provider Registry + SDK Factories](./phase-03-provider-registry-sdk-factories.md) | Pending |

## Frozen Interfaces

Plan 2 consumes these verbatim. Changing one requires updating
`plans/260918-1210-rag-typesafe-pipeline/plan.md` in the same change.

```ts
// src/vault/store.ts
type VaultStatus = 'locked' | 'unlocking' | 'unlocked' | 'recovering'
interface VaultState {
  status: VaultStatus
  settings: Settings | null
  unlockGeneration: number
  error: string | null
  setup(password: string): Promise<void>
  unlock(password: string): Promise<void>
  lock(): Promise<void>
  update(patch: DeepPartial<Settings>): Promise<void>
}

// src/ai/llm.ts
function createLLM(settings: Settings, providerId: string, modelOverride?: string): LanguageModel

// src/ai/typesafe.ts
function createTypeSafe(settings: Settings): TypeSafeClient
```

## Success Criteria

- [ ] A password unlocks the app; a wrong password reveals nothing.
- [ ] A hard reload unlocks with the same password (proves the plaintext salt path).
- [ ] Provider configuration and secrets persist across reload in encrypted form.
- [ ] An automated byte-scan test finds no plaintext secret in the vault records.
- [ ] `createLLM(settings, providerId)` returns a working language model for a configured provider.
- [ ] `createTypeSafe(settings)` constructs in-browser and completes one live `systemOne` call (manual, recorded).
- [ ] Strict CSP is in place and the app runs under it.
- [ ] `pnpm lint` and `pnpm build` pass; `pnpm test` passes with the new suites.

## Key Decisions

- **PBKDF2-SHA256 (600k iterations) + AES-GCM 256** via WebCrypto. No dependency; the
  derived key is non-extractable and lives only in memory. `KdfParams` is a
  discriminated union, so a future `argon2id` arm is expressible, but adding it still
  requires `hash-wasm` and a re-encrypt-and-migrate step — the plan does not claim a
  zero-cost swap.
- **Hard vault.** A forgotten password means unrecoverable data. No recovery key,
  no export. This is an explicit product decision, not a limitation to fix.
- **Encryption scope.** Secrets, provider configuration, and RAG settings are
  encrypted. Salt and KDF parameters are plaintext because they are required before
  decryption; document content and vectors (Plan 2) are also encrypted.
- **AAD binds ciphertext to record identity.** A blob moved to a different record
  fails to decrypt rather than silently substituting.
- **`dangerouslyAllowBrowser: true`** is accepted for this local/personal app. A strict
  CSP is the compensating control, and a public deployment requires a server proxy.
- **Versioned settings blob.** Schema version is written at creation so Plan 2 can
  migrate without discarding user data.

## Pre-Work

- Initialize a git repository before Phase 1 so each phase lands as a revertible
  commit. The workspace currently has no version control, so a failed build or a
  botched Dexie change cannot otherwise be rolled back.

## Red Team Review

Three hostile reviewers (Security Adversary, Assumption Destroyer, Failure Mode
Analyst) reviewed the plan against the installed packages and the template source.
Findings that carried a verified `file:line` citation were adjudicated and all were
accepted. Resulting changes:

**Critical**

1. Salt and iteration count moved out of the encrypted blob into a plaintext `meta`
   record. Nesting them was a bootstrap deadlock that hard-locked users on first reload.
2. `createVault` made atomic in one Dexie transaction with an in-transaction re-check
   and a module-scope in-flight guard. Previously a StrictMode double-setup could write
   two salts and make the vault permanently undecryptable.
3. `update(patch)` serialized through a single write queue with deep merge. Three
   independent writers in Phase 3 could previously drop each other's fields silently.
4. `lock()` now drains the in-flight write queue before clearing the key;
   `update` captures the key before any `await` and rejects with `VaultLockedError`.
5. Corruption distinguished from a wrong password via a canary blob, with a separate
   recovery screen; previously every GCM tag failure reported "wrong password".
6. Provider secret fields render masked and populate only on explicit reveal.
7. A strict CSP added as the compensating control for in-memory keys; a
   no-`dangerouslySetInnerHTML` rule carried into the Plan 2 handoff.
8. `KdfParams` changed to a discriminated union and the false "easy Argon2 swap" claim
   removed; adding `argon2id` is documented as a migration, not a drop-in.

**High**

9. `EncryptedBlob` gains `aad` binding so ciphertext cannot be substituted between records.
10. `navigator.storage.persist()` requested at setup with the result recorded; quota
    errors throw a typed `VaultStorageError`.
11. Memoized SDK clients keyed to `unlockGeneration` so `lock()` discards them.
12. `createTypeSafe` pins `logLevel: 'warn'`; the TypeSafe SDK logs unredacted request
    bodies (query text and chunks) at `debug`.
13. `assertSubtle` guards every exported crypto function, not only `deriveKey`.
14. `ErrorBoundary` plus an `unhandledrejection` listener added so a Dexie open failure
    renders a recoverable screen instead of a blank page.
15. Frozen interface block added (`createLLM(settings, providerId, modelOverride?)`),
    Vitest config plus `vitest/globals` types plus `fake-indexeddb` added, and manual
    criteria (DevTools eyeballing, live `systemOne` in CI) replaced with automated tests
    or recorded manual validations.

**Notes applied**

- The SDK source citation corrected from `src/client.ts` to
  `dist/index.mjs:511`; the package publishes `dist/` only.
- `git init` added to pre-work so phases are revertible.
- Effort raised from 14h to 22h to reflect the added crypto, concurrency, CSP, and
  test-infra work.
- The injection acceptance criterion in Plan 2 reworded as best-effort with a recorded
  bypass class.

### Whole-Plan Consistency Sweep

- `createLLM` signature is now identical in `plan.md`, Phase 3,
  Phase 3's architecture block, and the RAG plan.
- Salt/iterations described as plaintext consistently in `plan.md`, Phase 1, Phase 2,
  and the brainstorm report.
- `KdfParams` union, AAD, and the canary path described once in Phase 1 and referenced
  consistently in Phase 2.
- No remaining reference to `src/client.ts`, to an "unlocking guard on unlock", or to
  a `createTypeSafe` call without its settings argument.

## Validation Log

### Verification Results

- Claims checked: 24 (across 3 phases)
- Verified: 21 | Failed: 0 | Unverified: 3 (deferred to execution: PBKDF2 timing,
  live `systemOne` browser call, provider-utils build resolution)
- Tier: Standard (3 phases)
- Method: direct inspection of `package.json`, `tsconfig.app.json`, `main.tsx`, and
  the installed `@typesafe-ai/sdk` / `@ai-sdk/openai-compatible` package metadata.

### Open Items

- `systemOne` browser smoke test requires a live TypeSafe key; recorded as a manual
  validation rather than a CI gate.
- PBKDF2 iteration timing is machine-specific; recorded as a note, not an assertion.
