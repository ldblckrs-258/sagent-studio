---
title: "Phase 2: Settings Store + Vault Shell"
status: todo
---

# Phase 2: Settings Store + Vault Shell

## Context Links

- [Plan overview](./plan.md)
- [Phase 1: Vault Crypto Core](./phase-01-vault-crypto-core.md)
- [Phase 3: Provider Registry + SDK Factories](./phase-03-provider-registry-sdk-factories.md)
- [Brainstorm source](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md)

## Overview

- **Priority:** P1
- **Status:** todo
- **Description:** Turn the Phase 1 crypto helpers into a persistent, versioned
  settings store and an app shell that gates everything behind a password. Includes
  first-run setup, unlock, lock, idle auto-lock, and encrypted updates.

Document content and embeddings are out of scope; those belong to the RAG plan. This
phase handles configuration and secrets only.

## Key Insights

- Dexie stores `Uint8Array` natively, so ciphertext, IV, and salt need no base64 hop.
- **Salt and iteration count are plaintext and live in the `meta` table.** They are
  required before decryption, so they cannot be inside the encrypted blob. Nesting
  them in the ciphertext is the classic bootstrap deadlock: setup succeeds, reload
  cannot derive the key, and a hard vault becomes permanently unreadable.
- React 19 StrictMode double-invokes mount effects in development. The dangerous
  path is first-run setup, not unlock: two runs generate two salts and two keys, the
  last `put` wins on disk, and the in-memory key may belong to the losing salt.
- A React context re-render storm on `unlock` is easy to introduce; keep the
  transition inside a single Zustand action and read state by selector.
- The plaintext settings object exists in memory by necessity. It is cleared on lock,
  not on every read.
- `update(patch)` is a read-modify-write of one encrypted record. Multiple writers
  exist in Phase 3 (providers panel, TypeSafe form, egress notice dismissal), so
  concurrent updates silently drop fields unless writes are serialized.
- Idle auto-lock can fire while an `update()` is in flight. `lock()` must drain the
  write queue before clearing the key, or the write encrypts with a null key or lands
  after the store reports `locked`.
- Browsers treat unpersisted origin storage as evictable. A hard vault that is
  silently evicted is total data loss, so persisted storage must be requested and
  quota errors must be typed and surfaced.
- `tsconfig.app.json` sets `verbatimModuleSyntax` and `erasableSyntaxOnly`; use
  `import type` and string-literal unions rather than `enum` for vault status.

## Requirements

### Functional

- Dexie tables:
  - `vault` — the single encrypted settings record (`id: 'settings'`).
  - `meta` — plaintext `KdfParams` (algorithm, iterations, salt), the canary blob,
    the settings schema version, `persistedStorage` flag, and timestamps.
- First-run flow, atomic: inside one `db.transaction('rw', db.vault, db.meta, ...)`,
  re-check that no vault exists, generate the salt, derive the key, encrypt default
  settings and the canary, then write both records.
- `hasVault()` distinguishes three states: no records, complete vault, and partial
  state. It must never treat a partial write as a complete vault.
- `unlock(password)` derives the key from the plaintext `meta` parameters, decrypts
  the canary first to disambiguate a wrong password from corruption, then decrypts
  settings and hydrates them.
- `lock()` clears the idle timer, awaits any in-flight write, then clears the derived
  key and decrypted settings, and increments `unlockGeneration` so memoized SDK
  clients are invalidated.
- Idle auto-lock (default 15 minutes, configurable) with activity-based reset.
- `update(patch)` deep-merges into a serialized write queue, re-encrypts, and persists.
- Settings schema versioned; an unknown future version raises a migration error
  instead of discarding data.
- `navigator.storage.persist()` is requested at setup and its result recorded; quota
  errors throw a typed `VaultStorageError`.

### Non-functional

- No secret in `localStorage`, `sessionStorage`, logs, or the DOM.
- Unlock drives a `status` state machine: `locked | unlocking | unlocked`.
- An `ErrorBoundary` plus an `unhandledrejection` listener route vault failures to the
  store's `error` field, so a Dexie open failure does not white-screen the app.
- Existing Vite/Tailwind/Radix styling conventions are followed; no new UI framework.

## Architecture

```
App mount (ErrorBoundary + unhandledrejection listener)
  └─▶ vault store reads db.vault AND db.meta
        ├─ neither record ────▶ SetupScreen ──▶ createVault()  [one transaction]
        │                                          │
        │                                          ├─ navigator.storage.persist()
        │                                          ├─ salt + KdfParams -> meta (plaintext)
        │                                          ├─ deriveKey -> CryptoKey (memory only)
        │                                          ├─ encrypt(defaults, aad) -> vault
        │                                          └─ encrypt(canary, aad)   -> meta
        ├─ both records ──────▶ UnlockScreen ──▶ unlock(password)
        │                                          ├─ deriveKey(meta.kdfParams)
        │                                          ├─ decryptCanary  -> wrong pw vs corrupt
        │                                          ├─ decrypt(vault) -> Settings
        │                                          └─ unlockGeneration++
        └─ partial records ───▶ RecoveryScreen ──▶ eraseVault() and re-run setup
                                                     (typed VaultPartialStateError)

unlocked ──▶ app renders → consumers read settings via selectors
             update(patch) ──▶ deep merge ──▶ serialized write queue ──▶ encrypt+put
lock()   ──▶ clear idle timer ──▶ await write queue ──▶ clear key+settings ──▶ locked
idle     ──▶ lock()
```

State-machine table (a test per row):

| vault record | meta record | Behavior |
| --- | --- | --- |
| absent | absent | First-run setup |
| absent | present | Partial state: recovery screen, offer erase |
| present | absent | Partial state: recovery screen, offer erase |
| present | present | Unlock |
| present (corrupt) | present | `CorruptVaultError` with erase option, not "wrong password" |

Settings shape (encrypted inside the vault record):

```
{
  version: 1,
  providers: ProviderConfig[],        // consumed in Phase 3
  typesafe: { apiKey, model, baseURL? },
  rag: { embedModel, chunkSize, overlap, topK, thresholds, concurrency }  // consumed by Plan 2
}
```

`meta` (plaintext):

```
{
  id: 'kdf',
  kdfParams: KdfParams,               // algorithm, iterations, salt
  canary: EncryptedBlob,              // for wrong-password vs corruption
  settingsVersion: 1,
  persistedStorage: boolean,
  createdAt, updatedAt
}
```

## Related Code Files

**Create**

- `src/vault/db.ts` — Dexie database and schema.
- `src/vault/settings.ts` — settings type, defaults, version constant, migration.
- `src/vault/store.ts` — Zustand vault store with `setup`, `unlock`, `lock`, `update`.
- `src/vault/write-queue.ts` — serialized deep-merge write queue.
- `src/vault/use-idle-lock.ts` — idle timer hook.
- `src/vault/UnlockScreen.tsx` — first-run setup and unlock form.
- `src/vault/RecoveryScreen.tsx` — partial-state and corruption recovery.
- `src/vault/ErrorBoundary.tsx` — render-error boundary for vault failures.
- `src/vault/store.test.ts` — store behavior tests.
- `src/vault/settings.test.ts` — defaults and migration tests.
- `src/vault/test-fixtures.ts` — a checked-in encrypted v1 blob + expected settings.

**Modify**

- `src/App.tsx` — gate on vault status; render `UnlockScreen` or `RecoveryScreen`.
- `src/main.tsx` — wrap `App` in `ErrorBoundary`; register the `unhandledrejection` listener.

**Delete**

- None.

## Implementation Steps

1. Create `src/vault/db.ts` with a Dexie subclass exposing `vault` (keyPath `id`)
   and `meta` (keyPath `id`). Set `id: 'settings'` for the settings record and
   `id: 'kdf'` for the meta record.
2. Create `src/vault/settings.ts`: `SETTINGS_VERSION = 1`, `defaultSettings()`,
   `deepMerge(base, patch)`, `migrate(version, data)`, and the `Settings` type. Use
   `import type` for all type-only imports.
3. Implement `hasVault()` returning `'none' | 'complete' | 'partial'` by reading both
   records; never treat a single record as a complete vault.
4. Implement `createVault(password)` inside one
   `db.transaction('rw', db.vault, db.meta, ...)`: re-check both records are absent,
   call `navigator.storage.persist()` and record the boolean, generate the salt,
   derive the key, encrypt defaults and the canary, write `vault` then `meta`.
   Guard the whole function with a module-scope in-flight promise so a second call
   awaits the first instead of duplicating it.
5. Implement `unlock(password)` with the canary check: derive the key from
   `meta.kdfParams`, decrypt the canary; on success decrypt settings; on canary
   failure throw `WrongPasswordError`; on settings failure after a canary success
   throw `CorruptVaultError`. Validate the settings version and call `migrate`.
6. Implement the Zustand store with `status`, `settings`, `key`, `unlockGeneration`,
   `error`, `setup`, `unlock`, `lock`, and `update`. Use a string-literal union for
   `status`. All rejections are caught inside the action and mapped to typed messages.
7. Implement `src/vault/write-queue.ts`: a single promise chain that serializes
   `update(patch)` calls, deep-merges into the latest snapshot, captures the key into
   a local const before any `await`, and rejects with `VaultLockedError` if the vault
   locked mid-operation.
8. Implement `update(patch)` on top of the queue, bumping `updatedAt` and catching
   `QuotaExceededError` into `VaultStorageError`.
9. Add `use-idle-lock` with a configurable timeout and activity listeners
   (`pointerdown`, `keydown`, `visibilitychange`). Clear listeners on unmount.
10. Implement `lock()`: clear the idle timer, await the write queue, then clear the
    key and settings and increment `unlockGeneration`. Memoized SDK clients in Phase 3
    key off `unlockGeneration` and are discarded when it changes.
11. Build `UnlockScreen` covering first-run setup and subsequent unlock, with loading
    state and typed error messages. A short note that the password cannot be recovered
    is required. Do not render stored secrets into inputs.
12. Build `RecoveryScreen` for partial and corrupt states with an explicit
    "erase vault and start over" action.
13. Build `ErrorBoundary` and register an `unhandledrejection` listener in
    `main.tsx` that forwards vault errors into the store.
14. Modify `App.tsx` to render `UnlockScreen`, `RecoveryScreen`, or the app based on
    vault status.
15. Write tests: per-row of the state-machine table; create → lock → unlock round-trip;
    wrong password vs corrupted ciphertext produce different errors; concurrent
    `update` calls both survive; a lock during an in-flight update yields
    `VaultLockedError` and leaves disk consistent; `createVault` called twice
    concurrently yields one salt, one key, one record; unknown schema version throws;
    an automated byte-scan of `db.vault.toArray()` and `db.meta.toArray()` finds no
    seeded plaintext key material.
16. Write settings tests: defaults shape, `deepMerge` behavior, and `migrate` against
    the checked-in fixture blob.

## Todo

- [ ] Create Dexie database with `vault` and `meta` tables
- [ ] Define `Settings`, `SETTINGS_VERSION`, `deepMerge`, and migration
- [ ] Implement `hasVault` returning none/complete/partial
- [ ] Implement atomic `createVault` with an in-flight guard and `storage.persist()`
- [ ] Implement `unlock` with canary-based wrong-password vs corruption detection
- [ ] Implement the Zustand vault store with idempotent transitions
- [ ] Implement the serialized deep-merge write queue
- [ ] Implement `update(patch)` with quota handling
- [ ] Implement idle auto-lock with a configurable timeout
- [ ] Implement `lock()` draining the write queue and bumping `unlockGeneration`
- [ ] Build `UnlockScreen`, `RecoveryScreen`, and `ErrorBoundary`
- [ ] Gate `App.tsx` on vault status; register `unhandledrejection`
- [ ] Write state-machine, concurrency, and automated secret-scan tests
- [ ] Write the migration test against a checked-in fixture blob

## Success Criteria

- First run sets a password and lands in the unlocked app; a hard reload then unlocks
  with the same password (proves the plaintext salt/iterations path).
- A wrong password shows a distinct message from a corrupted vault.
- Changing a setting, reloading, and unlocking preserves the change.
- Two concurrent `update` calls both survive; neither field is lost.
- An automated test byte-scans the vault and meta records and finds no seeded plaintext
  key material. This replaces manual DevTools inspection.
- A partial first-run write routes to the recovery screen instead of a permanent
  "wrong password" loop.
- `lock()` and idle timeout both clear key, settings, and invalidate memoized clients.
- An injected Dexie open failure renders a recoverable error screen, not a blank page.
- `pnpm test`, `pnpm lint`, `pnpm build` all pass.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Salt placed inside the encrypted blob, deadlocking unlock | Medium | Critical | Salt and iterations are plaintext in `meta`; covered by the reload success criterion |
| StrictMode double setup writes two salts and locks the user out | High | Critical | Module-scope in-flight promise plus an in-transaction re-check; concurrent-setup test |
| Partial first-run write produces an unescapable unlock loop | Medium | Critical | `hasVault` three-state result plus a recovery screen with erase |
| Concurrent `update` calls silently drop fields | High | High | Single serialized write queue with deep merge; concurrency test |
| Idle lock races an in-flight update | Medium | High | `lock()` drains the queue first; `update` captures the key before `await`; typed `VaultLockedError` |
| Unpersisted storage silently evicted | Medium | High | `navigator.storage.persist()` at setup, result recorded, warning surfaced if denied |
| Corruption reported as a wrong password | Medium | High | Canary record disambiguates; distinct errors and a recovery action |
| Async unlock rejection white-screens the app | Medium | High | `ErrorBoundary` plus `unhandledrejection` routing into the store; injected-failure test |
| Secrets leaking through dev tooling | Medium | High | Never log settings; automated byte-scan test replaces eyeballing DevTools |
| Unbounded settings growth from provider/model lists | Low | Medium | Cap provider count and model-list length in validation |

## Security Considerations

- The vault key is held in memory only, never persisted.
- Salt and KDF parameters are plaintext by necessity; they are not secret.
- Provider and TypeSafe secrets live exclusively inside the encrypted blob.
- The unlock screen states plainly that the password is unrecoverable.
- Automatic lock limits the window in which a walked-away session stays open, and
  invalidates memoized clients so keys do not survive the lock.
- This phase does not add a CSP. Key material remains reachable by injected script;
  containment is documented as a deployment concern in the plan overview.

## Next Steps

Phase 3 reads `settings.providers` and `settings.typesafe` from the unlocked store,
builds the SDK factories on top, and keys memoized client instances off
`unlockGeneration` so `lock()` discards them. Plan 2 consumes the same store for its
RAG settings and thresholds.
