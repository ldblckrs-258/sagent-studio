---
title: "Phase 1: Vault Crypto Core"
status: todo
---

# Phase 1: Vault Crypto Core

## Context Links

- [Plan overview](./plan.md)
- [Brainstorm source](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md)
- [Phase 2: Settings Store + Vault Shell](./phase-02-settings-store-vault-shell.md)

## Overview

- **Priority:** P1 (blocking — every later phase depends on these helpers)
- **Status:** todo
- **Description:** Browser-native cryptography helpers: PBKDF2 key derivation, AES-GCM
  encryption and decryption, typed errors, and the test harness. No third-party crypto
  dependency.

Everything that persists sensitive data routes through this module, so it is built
and tested before any store or UI exists.

## Key Insights

- WebCrypto (`crypto.subtle`) is native to the platform; no dependency is required.
- `crypto.subtle` is `undefined` outside a secure context. Tests run under Node's
  WebCrypto, which is always present, so a missing-subtle bug only appears in a
  misconfigured deployment. Guard every exported function, not just `deriveKey`.
- `getRandomValues` exists even in insecure contexts, so randomness working is not
  evidence that `subtle` is available.
- `getRandomValues` is the only correct randomness source; `Math.random` must never
  be used for salts or IVs.
- A 12-byte IV is the correct size for AES-GCM. A 16-byte salt is enough for PBKDF2.
- WebCrypto returns `ArrayBuffer`, while Dexie stores `Uint8Array` cleanly. Normalize
  at the module boundary so callers never juggle buffer types.
- The project build runs `tsc -b` over `src/`, so test files are type-checked too.
  `tsconfig.app.json` sets `verbatimModuleSyntax: true` (type-only imports need
  `import type`) and `erasableSyntaxOnly: true` (no `enum`; use string-literal unions).
- `@typesafe-ai/sdk` publishes only `dist/`, `LICENSE`, and `README.md` — no `src/`.
  Any future SDK-source citation must target `dist/index.mjs`, not `src/client.ts`.

## Requirements

### Functional

- `randomBytes(length)` returns cryptographically random bytes.
- `deriveKey(password, params)` returns a non-extractable AES-GCM `CryptoKey`, where
  `params` is a discriminated `KdfParams` union so a future algorithm is expressible
  without a vault-format break.
- `encrypt(key, plaintext, aad)` returns `{ iv, ciphertext }` with a fresh random IV.
- `decrypt(key, blob, aad)` returns the original plaintext or throws.
- Typed errors: `VaultLockedError`, `WrongPasswordError`, `CorruptVaultError`,
  `InsecureContextError`.
- Serialization helpers that round-trip `Uint8Array` through Dexie without coercion.

### Blob shape and record binding

- `EncryptedBlob { iv: Uint8Array; ciphertext: Uint8Array }` carries no salt and no
  KDF parameters. Salt and iteration count are **plaintext** and live in `KdfParams`,
  persisted outside the ciphertext (Phase 2 stores them in the `meta` table). Putting
  them inside the blob would make unlock impossible.
- `encrypt`/`decrypt` take an `aad` (additional authenticated data) argument bound to
  the record identity, for example `new TextEncoder().encode('settings:v1')` or a
  document id. AES-GCM authenticates AAD without encrypting it, so a ciphertext moved
  to a different record fails to decrypt instead of silently substituting.
- A small canary record encrypted under the same key is written at setup. On unlock,
  a tag failure is ambiguous between a wrong password and corruption; decrypting the
  canary disambiguates the two.

### Non-functional

- Default iterations: 600,000 (PBKDF2-SHA256).
- No secret is logged at any log level.
- Module is free of React and Dexie imports so it is trivially testable.

## Architecture

```
password ──┐
           ├─▶ deriveKey(PBKDF2-SHA256, 600k, salt) ──▶ CryptoKey (non-extractable)
KdfParams ─┘   (algorithm, iterations, salt — plaintext, persisted by Phase 2)          │
                                                          ▼
plaintext + aad ──▶ encrypt(AES-GCM, random IV) ──▶ { iv, ciphertext } ──▶ Dexie
blob + aad ───────▶ decrypt(AES-GCM) ─────────────▶ plaintext | WrongPasswordError | CorruptVaultError

Setup also writes a canary blob under the same key. Unlock uses it to tell a wrong
password apart from a corrupted ciphertext, which AES-GCM alone cannot distinguish.
```

## KDF Interface

`KdfParams` is a discriminated union so a stronger KDF is addable without changing the
call sites or the persisted blob format:

```ts
type KdfParams =
  | { algorithm: 'PBKDF2-SHA256'; iterations: number; salt: Uint8Array }
  | { algorithm: 'argon2id'; memoryKiB: number; iterations: number; salt: Uint8Array }

function deriveKey(password: string, params: KdfParams): Promise<CryptoKey>
```

Only the `PBKDF2-SHA256` arm is implemented in this plan. The `argon2id` arm is a
declared shape, not a working implementation; adding it still requires `hash-wasm` and
a re-encrypt-and-migrate step, so the plan does not claim a zero-cost swap.

## Related Code Files

**Create**

- `src/vault/crypto.ts` — `randomBytes`, `deriveKey`, `encrypt`, `decrypt`, `assertSubtle`.
- `src/vault/errors.ts` — typed error hierarchy.
- `src/vault/types.ts` — `KdfParams` (discriminated union), `EncryptedBlob`.
- `src/vault/crypto.test.ts` — round-trip and failure tests.
- `vitest.config.ts` — Vitest config with `globals: true` and a setup file.

**Modify**

- `package.json` — add `vitest`, `fake-indexeddb`; add `test` and `test:watch` scripts.
- `tsconfig.app.json` — add `vitest/globals` to `types`.

**Delete**

- None.

## Implementation Steps

1. Install Vitest (`vitest`, `fake-indexeddb`) and add `"test": "vitest run"` and
   `"test:watch": "vitest"` to `package.json`. Create `vitest.config.ts` with
   `globals: true` and a setup file that imports `fake-indexeddb/auto`.
2. Add `"vitest/globals"` to `types` in `tsconfig.app.json` so `tsc -b` accepts bare
   `describe`/`it`/`expect` in test files.
3. Create `src/vault/errors.ts` with the four error classes extending `Error`, each
   setting `name` explicitly.
4. Create `src/vault/types.ts` with the `KdfParams` discriminated union and
   `EncryptedBlob { iv: Uint8Array; ciphertext: Uint8Array }`.
5. Implement `assertSubtle()` and call it at the entry of `randomBytes`, `deriveKey`,
   `encrypt`, and `decrypt`; throw `InsecureContextError` when `crypto.subtle` is
   unavailable.
6. Implement `randomBytes(length)` over `crypto.getRandomValues`.
7. Implement `deriveKey(password, params)`: switch on `params.algorithm`; the
   `PBKDF2-SHA256` arm uses `importKey` with `PBKDF2` and `deriveKey` to `AES-GCM` with
   `extractable: false` and usages `['encrypt', 'decrypt']`. Throw a typed error for
   the unimplemented `argon2id` arm.
8. Implement `encrypt(key, plaintext, aad)` and `decrypt(key, blob, aad)` over
   `crypto.subtle.encrypt` / `decrypt`, passing `aad` as `additionalData`. Normalize
   `Uint8Array` and `ArrayBuffer` at both boundaries.
9. In `decrypt`: validate blob shape and IV length first and throw `CorruptVaultError`
   for malformed input; on a tag failure throw `WrongPasswordError`. Provide a
   separate `decryptCanary(key, canary)` path used by Phase 2 to disambiguate a wrong
   password from a corrupted settings blob.
10. Write tests: round-trip a UTF-8 string and a large payload; wrong password;
    tampered ciphertext; tampered IV; empty input; `randomBytes` produces distinct
    values; AAD mismatch fails; stubbing `globalThis.crypto.subtle = undefined`
    produces `InsecureContextError` from every exported function.
11. Measure `deriveKey` wall time in a test and log it as a machine-specific note so
    the iteration count has a recorded baseline. Do not assert on the timing.

## Todo

- [ ] Add `vitest`, `fake-indexeddb`, `vitest.config.ts`, and the `test` scripts
- [ ] Add `vitest/globals` to `tsconfig.app.json` types
- [ ] Create `src/vault/errors.ts` with the four typed errors
- [ ] Create `src/vault/types.ts` with `KdfParams` union and `EncryptedBlob`
- [ ] Implement `assertSubtle` called from every exported function
- [ ] Implement `randomBytes` over `crypto.getRandomValues`
- [ ] Implement `deriveKey` with a non-extractable AES-GCM key and an `argon2id` stub arm
- [ ] Implement `encrypt` with a fresh random IV and AAD binding
- [ ] Implement `decrypt` with shape validation and tag-failure mapping
- [ ] Implement and test the canary decrypt path
- [ ] Write round-trip, AAD-mismatch, insecure-context, and failure tests
- [ ] Record PBKDF2 derivation time as a machine-specific note

## Success Criteria

- Round-trip encrypt/decrypt returns byte-identical plaintext for small and large inputs.
- A wrong password throws `WrongPasswordError` and never returns partial plaintext.
- Tampered ciphertext, tampered IV, or a mismatched AAD throws `CorruptVaultError`.
- With `crypto.subtle` stubbed away, every exported function throws
  `InsecureContextError` rather than a raw `TypeError`.
- `pnpm test` passes; `pnpm lint` and `pnpm build` pass.
- Derivation time is recorded as a machine-specific note; if it exceeds roughly 1 second,
  raise the iteration count as an open question rather than silently lowering it.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| PBKDF2 at 600k is slow on low-end devices | Medium | Medium | Measure in step 11; treat iterations as a documented tunable with a floor |
| Silent failure outside a secure context | Low | High | `assertSubtle` guards every exported function, not just key derivation; tested by stubbing `subtle` away |
| Buffer-type confusion between `ArrayBuffer` and `Uint8Array` | Medium | Medium | Normalize at the module boundary; cover with tests |
| React Compiler or bundler mangling `crypto.subtle` access | Low | Medium | Keep this module dependency-free and framework-free |
| Missing AAD allows ciphertext substitution between records | Medium | High | `aad` binds a blob to its record identity; a moved blob fails to decrypt |
| Test files break `tsc -b` under `verbatimModuleSyntax` / `erasableSyntaxOnly` | High | Medium | Use `import type` for type-only imports and string-literal unions instead of `enum`; add `vitest/globals` to `types` |

## Security Considerations

- The derived key is non-extractable; it cannot be read back from JavaScript.
- Salts and IVs come only from `crypto.getRandomValues`.
- Plaintext and password never enter a log statement.
- Errors are typed but do not echo key material or plaintext in their messages.
- AAD binds each ciphertext to its record identity, so a blob cannot be swapped
  between records without failing authentication.
- This module does not contain a CSP or an XSS boundary. It keeps secrets in memory
  by design; containment against script injection is a deployment concern recorded in
  the plan overview, not a property of this module.

## Next Steps

Phase 2 imports `deriveKey`, `encrypt`, `decrypt`, and the typed errors to build the
Dexie-backed settings store and unlock flow.
