---
phase: 1
title: Encrypted store and scope matching
status: completed
priority: P2
effort: 3h
dependencies: []
---

# Phase 1 — Encrypted store and scope matching

## Goal

Memories persist as encrypted vault records. An in-memory store hydrates them, validates writes, enforces limits, and matches workspace scopes by folder handle.

## Files

- Create:
  - `src/memory/types.ts`
  - `src/memory/store.ts`
  - `src/memory/state.ts`
- Modify:
  - `src/vault/db.ts`: `MemoryRecord`, schema v7.
  - `src/vault/store.ts`: clear `db.memories` in `recover()` and `vaultInternals.reset`.
  - `src/workspace/handle.ts`: export `sameDirectory(a, b)`.
  - `src/session/workspace-state.ts`: `sameFolder` delegates to `sameDirectory`.
- Tests:
  - `src/memory/store.test.ts`
  - `src/memory/state.test.ts`

## Steps

1. **Types (`types.ts`).**
   - Scope: `MemoryScope = { kind: 'global' } | { kind: 'workspace'; scopeId: string; label: string }`.
   - Record: `Memory = { id, title, body, scope, important, source: 'model' | 'user', threadId?, createdAt, updatedAt }`.
   - Input: `MemoryDraft = { title, body, important?, scope: 'global' | 'workspace' }`.
   - The limit constants from the plan table.
   - Errors: `MemoryLimitError`, `MemoryConflictError`, `MemoryNotFoundError`, `MemoryScopeError`. Each carries a code the tools map to `toolFail`: `memory_full`, `conflict`, `not_found`, and `invalid_input`.
2. **Schema (`db.ts`).**
   - Add `this.version(7)`, repeating every v6 store and adding `memories: 'id, updatedAt'`.
   - `MemoryRecord` is `{ id, blob, updatedAt }`. No other field is plaintext.
3. **Encrypted store (`store.ts`).** Follow the `src/skills/store.ts` pattern.
   - The envelope is `{ version: 1, memory }` with AAD `memory:<id>`. A newer version or a malformed shape throws a parse error.
   - `saveMemory` and `removeMemory` run through `vaultWriteQueue`. `listMemories` decrypts every row.
   - Scope handles: `saveScopeHandle(scopeId, handle)`, `listScopeHandles()` (all `db.fs` rows whose id starts with `memscope:`), and `removeScopeHandle(scopeId)`.
4. **Handle comparison.** `sameDirectory(a, b)` in `src/workspace/handle.ts`:
   - returns true when both are the same object;
   - otherwise calls `a.isSameEntry(b)` when it exists;
   - returns false on a throw or when `isSameEntry` is missing.
   `sameFolder` keeps its null handling and delegates the handle comparison to it.
5. **Store (`state.ts`, zustand `useMemoryStore`).**
   - **State:** `memories`, `scopes` (`scopeId → { handle, label }`), `status: 'idle' | 'loading' | 'ready' | 'error'`, and `error`.
   - **`hydrate()` and `clear()`.** Hydrate decrypts every memory and loads the scope handles. It deletes a scope handle that no memory references.
   - **`resolveScope(handle | null)`.** Returns the `scopeId` whose stored handle matches through `sameDirectory`, or null.
   - **`ensureScope(handle)`.** Returns the matching `scopeId`. Otherwise it creates one with `crypto.randomUUID()` and `label = handle.name`, then saves the handle.
   - **`visible(scopeId | null)`.** Global memories plus the memories of that scope.
   - **`create(draft, { source, threadId?, handle? })`.**
     - Trims the title. It must be non-empty, at most 120 characters, and single-line; newlines are rejected.
     - The body must be 1 to 2,000 characters.
     - The total must stay at or below 500 memories.
     - A duplicate title in the same scope throws a conflict.
     - Important bodies in the target scope must stay at or below 2,000 characters.
     - `scope: 'workspace'` without a handle throws `MemoryScopeError`.
     - Ids are `mem_` plus 10 random base36 characters.
   - **`update(id, patch, { handle? })`.** Uses the same validation. A scope change re-checks the target scope's budget and title uniqueness.
   - **`remove(id)`.** Deletes the record, then removes the scope handle when no memory uses it any more.
   - Every write persists first and updates the state after.

## Tests (intent)

- **Encryption.** A seeded marker string in the title and body never appears in the raw `db.memories` row. This is the vault's core promise.
- **Wrong key.** A record decrypted under a different key fails, and a locked keyring throws `VaultLockedError`. Memory must never be readable without the password.
- **Round trip.** Save, list, and remove round-trip, and a v2 envelope is rejected. Old builds must not misread newer data.
- **Same-name folders.** `resolveScope` matches a handle whose `isSameEntry` returns true and ignores one that only shares the name. Two folders with the same name must not share memories.
- **Scope creation.** `ensureScope` reuses an existing scope and creates exactly one new scope per folder.
- **Budget.** An important write that crosses the 2,000-character scope budget throws and stores nothing. A write in another scope is unaffected.
- **Duplicates.** A duplicate title in the same scope throws a conflict. The same title in another scope succeeds.
- **Orphan cleanup.** Removing the last memory of a scope deletes its `memscope:` handle.
- **Wipe.** `recover()` leaves `db.memories` empty.

## Verification

- `pnpm exec vitest run src/memory src/vault src/session/workspace-state.test.ts`
- `pnpm exec tsc -b`
