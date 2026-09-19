---
phase: 2
title: "Encrypted Thread Persistence"
status: done
priority: P1
effort: "8h"
dependencies: [1]
---

# Phase 2: Encrypted Thread Persistence

## Goal

Persist `ChatThread` records encrypted at rest through a shared vault write queue,
using an additive key/record API where `keyring` is the single source of key and
generation, so no write can land after lock and concurrent saves cannot reorder.

## Context

- `src/vault/store.ts:49` holds the `CryptoKey` in a module variable;
  `:342` exposes `vaultInternals`. `unlockGeneration` is zustand state written in
  five places (`:36,241,262,294,325`) and asserted by tests (`store.test.ts:127`).
- `src/vault/write-queue.ts` provides `createWriteQueue`; `store.ts:289` drains it
  in `lock()`, but settings writes are its only user.
- `src/vault/crypto.ts:86,133` are the only primitives; errors in
  `src/vault/errors.ts`.
- `src/vault/db.ts:28` is at `version(1)`.
- Plan 1 freezes `VaultState`; this phase is additive but changes generation
  ownership and must be recorded there.

## Requirements

Functional:

- `keyring.ts` owns `{ key, generation }` as one atomic pair:
  `install(key)` sets the key and increments generation in one call; `clear()`
  clears the key and increments generation; `snapshot()` returns both.
- A single shared `vaultWriteQueue` (exported from `src/vault/write-queue.ts` or a
  sibling module) is used by settings writes and record writes; `lock()`,
  `recover()`, and `reset()` drain it.
- `VaultState.unlockGeneration` is a projection of `keyring` generation (store
  reads it after install/clear) and `client-cache.setGeneration` is called with
  the same value.
- `encryptRecord(plaintext, aadSeed)` / `decryptRecord(blob, aadSeed)` capture a
  keyring snapshot before `await` and reject with `VaultLockedError` if it changed.
- Dexie `version(2)` adds `threads: 'id, updatedAt'`.
- `saveThread` enqueues its encrypt+put as one `vaultWriteQueue` task, so global
  FIFO serializes all record writes and preserves per-thread order.
- Thread CRUD: create, load, list metadata only, save, delete.
- Titles are encrypted inside the blob; only `id` and `updatedAt` are plaintext.

Non-functional:

- No plaintext content or title in IndexedDB, proven by a byte-scan test.
- Full existing vault suite green; the generation projection behavior is asserted.

## Architecture

```
src/vault/keyring.ts       install/clear/snapshot/current (key + generation)
src/vault/write-queue.ts   add shared `vaultWriteQueue` instance (or new queue.ts)
src/vault/records.ts       encryptRecord/decryptRecord + aadFor(seed)
src/vault/db.ts            version(2): threads: 'id, updatedAt'
src/chat/persistence.ts    createThread/loadThread/listThreads/saveThread/deleteThread
```

`store.ts` calls `keyring.install(derived)` where it currently assigns `key`, then
sets `unlockGeneration` from `keyring` generation. `lock()`/`recover()` call
`keyring.clear()` and drain `vaultWriteQueue`. `records.ts` does not import
zustand; it reads `keyring` directly.

Serialized envelope: `{ version: 1, thread: ChatThread }`.

## Files to Create / Modify

- Create: `src/vault/keyring.ts`
- Modify: `src/vault/write-queue.ts` (shared queue instance) and `src/vault/store.ts`
- Create: `src/vault/records.ts`
- Create: `src/vault/records.test.ts`
- Modify: `src/vault/db.ts` (version 2, `threads` table + `ThreadRecord`)
- Create: `src/chat/persistence.ts`
- Create: `src/chat/persistence.test.ts`
- Modify: `../260918-1209-core-infra-vault/plan.md` (record additive + generation)

## Implementation Steps

1. Add `src/vault/keyring.ts`:

   ```ts
   let key: CryptoKey | null = null
   let generation = 0
   export function install(next: CryptoKey) { key = next; generation += 1 }
   export function clear() { key = null; generation += 1 }
   export function snapshot() { return { key, generation } }
   export function getKey() { return key }
   export function getGeneration() { return generation }
   export function reset() { key = null; generation = 0 }
   ```

2. Move the settings `writeQueue` to a shared instance exported as
   `vaultWriteQueue`; update `store.ts` imports. Run `pnpm test -- src/vault` and
   confirm green before proceeding.
3. Refactor `store.ts` to use `keyring.install`/`clear`/`reset`; set
   `unlockGeneration: keyring.getGeneration()` and pass the same value to
   `setGeneration`. Keep `vaultInternals.getKey/hasKey/reset` semantics.
4. Add `src/vault/records.ts` capturing `snapshot()` before `await` and
   re-checking after; `aadFor(seed)` = `encoder.encode(`${seed}:v1`)`.
5. Add `ThreadRecord { id; blob; updatedAt }` and
   `this.version(2).stores({ vault: 'id', meta: 'id', threads: 'id, updatedAt' })`.
6. Add `src/chat/persistence.ts`:
   - `saveThread(thread)`: `vaultWriteQueue.enqueue(async () => { const blob =
     await encryptRecord(JSON.stringify({version:1, thread}), 'thread:'+thread.id);
     await db.threads.put({ id: thread.id, blob, updatedAt: thread.updatedAt }) })`.
   - `createThread` = `saveThread` after validating the thread.
   - `loadThread(id)`: get row, `decryptRecord`, `JSON.parse`, `migrateThread`
     (reject `version > 1`).
   - `listThreads()`: metadata only.
   - `deleteThread(id)`: enqueue a delete on `vaultWriteQueue` (delete is allowed
     while locked, so it may bypass the queue; document the choice).
7. Tests: records round-trip, locked rejection, lock-mid-call rejection; a
   `saveThread` racing `lock()` that asserts no record lands after lock resolves
   (mirror `store.test.ts:247`); concurrent saves complete in FIFO order; byte-scan
   finds no plaintext marker; envelope version rejection.
8. Append the additive-interface note and generation-ownership change to Plan 1.
9. `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] `src/vault/keyring.ts` (atomic key+generation)
- [x] shared `vaultWriteQueue`; store uses it; vault suite green
- [x] `store.ts` generation is a projection of keyring
- [x] `src/vault/records.ts` + tests
- [x] Dexie version 2 `threads` table
- [x] `src/chat/persistence.ts` (queue-serialized saves) + tests
- [x] Plan 1 frozen-interface note updated
- [x] lint / build / full test green

## Verification

- `pnpm test -- src/vault src/chat` passes.
- Lock race test: a save begun before `lock()` either completes before `lock()`
  resolves or rejects; no `threads` row is written after `lock()` resolves.
- FIFO test: two saves with a deferred encrypt resolve in enqueue order; the
  newest `updatedAt` wins.
- Byte-scan test: no marker in raw ciphertext or serialized rows.
- `pnpm lint` and `pnpm build` clean.

## Success Criteria

- Threads round-trip encrypted and survive reload.
- Locking makes every read/write reject; no write lands after lock.
- Concurrent saves never lose the newest turn.
- Generation has one owner (`keyring`) and the store reflects it.
- Plan 1's frozen interfaces are documented as extended, not broken.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Key refactor changes store behavior | Move assignments one-for-one; run the vault suite after step 2 and again at the end. |
| Record writes racing lock | All record writes go through `vaultWriteQueue`, which lock drains; encryptRecord re-checks the snapshot. |
| Concurrent saves reorder | Global FIFO queue serializes encrypt+put as one task. |
| Dexie upgrade corrupts existing vault | Purely additive version 2; test upgrade from version 1 data. |

## Security Considerations

- AAD binds ciphertext to `thread:{id}`; a blob moved to another thread fails to
  decrypt.
- Titles are encrypted so metadata leaks no conversation topics.
- Record rollback protection is not provided: a local attacker able to rewrite
  IndexedDB already holds broader power. Recorded as an accepted limitation.
- `keyring` holds the key in module scope exactly as before; no new key persistence.

## Next Steps

Phase 3 stores skills and user tool definitions with the same record API.
