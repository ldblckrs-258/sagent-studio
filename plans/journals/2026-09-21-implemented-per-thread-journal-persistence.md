# Implemented: Per-Conversation Journal Persistence

Checkpoints now survive a reload, are scoped to one conversation, and are
cleared when that conversation is deleted.

## Decisions (user-approved)

- Scope: one journal per conversation (thread), removed on conversation delete.
- Storage: encrypted Dexie row per thread, gzip payload, plus a memory byte
  budget.

## Implementation

- `src/workspace/journal.ts`: `snapshotState()`/`restoreState()` and a
  `MAX_TOTAL_SNAPSHOT_CHARS` (8 MB) budget. `prune()` evicts oldest entries past
  either the entry cap or the byte budget, and caps the checkpoint map.
- `src/workspace/journal-codec.ts`: gzip via `CompressionStream` with a `gz:`
  prefix; plain JSON fallback; corrupt or future-version payloads decode to null.
- `src/vault/db.ts`: version 5 adds the `journals` table.
- `src/workspace/journal-store.ts`: one journal per thread, loaded from Dexie on
  first use, debounced saves through `vaultWriteQueue` + `encryptRecord`,
  `flush`/`flushAll`/`remove`/`clearAll`, and `VaultLockedError` tolerance.
- Wiring: `ToolRuntimePorts.journal` carries the run's journal; `PipelineDeps.journalFor(threadId)`
  resolves it in `executeRun`; workspace and history providers read it (the old
  singleton is only a test/introspection fallback).
- Sandbox writes stay journaled: `RunOptions.journal` flows code/registry tools
  into `WorkerSession` -> `fs-bridge` -> `journaledWrite`.
- Lifecycle: `deleteConversation` calls `workspaceJournalStore.remove(id)`;
  `session.dispose()` flushes pending saves.

## Verification

- `pnpm test` 78 files, 803 passed / 1 skipped; `eslint` clean; `tsc -b` clean;
  `vite build` clean.
- New tests: codec round-trip and corrupt handling, byte-budget eviction,
  snapshot round-trip, store persistence into a fresh store, per-thread
  isolation, delete-on-remove.

## Limits

- Scoped to the conversation, not the folder: switching workspace does not clear
  a conversation journal, so a restore from a checkpoint captured against a
  different folder could write stale content. The conversation carries its own
  workspace label; documented, not guarded.
- A mutation while the vault is locked is not persisted; the in-memory journal
  remains and the next unlocked write re-saves the snapshot.
