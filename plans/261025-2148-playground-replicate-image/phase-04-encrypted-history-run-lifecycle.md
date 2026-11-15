---
phase: 4
title: Encrypted history and run lifecycle
status: completed
priority: P2
effort: 5h
dependencies: [1]
---

# Phase 4 — Encrypted history and run lifecycle

## Goal

Runs and their images are stored encrypted in two tables. A store runs the provider-neutral lifecycle (start, persist id, poll, download, save), survives lock with resume, bounds history by count and bytes, and owns the Playground save folder.

## Files

- Create:
  - `src/playground/store.ts` (persistence)
  - `src/playground/state.ts` (zustand store and lifecycle)
  - `src/playground/folder.ts`
- Modify:
  - `src/vault/db.ts`: `PlaygroundRunRecord`, `PlaygroundImageRecord`, `version(9)`.
  - `src/vault/store.ts`: clear both tables in `recover()` (`:354`) and `vaultInternals.reset` (`:410`). `recover()` already clears all of `db.fs`, which removes `playground:folder`.
  - `src/session/session-provider.tsx`: call `usePlaygroundStore.getState().clear()` next to the memory clear (`:91`). No hydrate call here.
- Tests:
  - `src/playground/store.test.ts`
  - `src/playground/state.test.ts`
  - `src/playground/folder.test.ts`

## Steps

1. **Schema (`db.ts`).**
   - `PlaygroundRunRecord = { id; blob: EncryptedBlob; createdAt: number }`.
   - `PlaygroundImageRecord = { id: '<runId>:<role>:<index>'; runId; blob: EncryptedBlob }`, where `role` is `input` or `output`.
   - `this.version(9)` repeats every v8 store and adds `playgroundRuns: 'id, createdAt'` and `playgroundImages: 'id, runId'`.
2. **Persistence (`store.ts`).**
   - Envelope `{ version: 1, run: RunMeta }`, AAD seed `playground-run:<id>`. Image AAD seed `playground-image:<imageId>`.
   - `RunMeta = { id, providerId, model, modelLabel, ref?, input, secretFields, inputImages: ImageRef[], outputs: OutputRef[], outputJson?, status, error?, providerRunId?, predictTime?, bytes, createdAt, completedAt? }`.
     - `ImageRef = { field, index, name, mime, size }`. In the stored `input`, each uploaded image value is replaced by `{ $image: index }`.
     - `OutputRef = { index, mime, size }`.
   - `createRun(meta, inputImages)`, `updateRun(meta)`, `addOutputs(meta, outputs)`: each runs inside one `vaultWriteQueue` task and one Dexie `rw` transaction over both tables.
   - `listRunMeta()` reads `db.playgroundRuns` only, decrypts row by row, and skips (and counts) rows that fail to decrypt or parse, so one bad row does not empty the gallery.
   - `loadImage(imageId)` decrypts one image row. `removeRuns(ids)` deletes runs and their images (`where('runId').anyOf(ids)`).
   - `pruneFor(newMeta, existing)` picks the oldest runs to remove so the total is ≤ 200 runs and ≤ 1 GiB of `bytes`; `createRun` and `addOutputs` call it in the same transaction, for every status.
   - Quota mapping: an error whose `name` or `inner.name` is `QuotaExceededError` becomes `PlaygroundError('storage_full', 'Browser storage is full. Delete some playground runs and try again.')`.
   - `parseEnvelope` rejects a newer version and an id mismatch, like `src/memory/store.ts:15`.
   - Export a `playgroundPersistence` seam.
3. **State (`state.ts`).** `usePlaygroundStore`:
   - `runs: RunMeta[]`, `active: Record<runId, { controller: AbortController }>`, `models: Record<'<providerId>:<slug>', PlaygroundModel>` (successful lookups only), `hydrated: boolean`, `skipped: number`.
   - `hydrate(providerFor)`: called on first Playground mount. Uses the generation-stamp pattern (`src/memory/state.ts:191`). After loading, each run with a non-terminal status and a `providerRunId` is resumed when `Date.now() - createdAt < retentionMs`, else marked `expired`. A non-terminal run without `providerRunId` is marked `interrupted`.
   - `start({ provider, model, input, fields, inputImages })`:
     1. `generation = keyring.getGeneration()`; every later step first checks `keyring.getGeneration() === generation` and stops quietly if not.
     2. Create the run record (`starting`, input without secrets, input images).
     3. `provider.start(...)`, then `updateRun` with `providerRunId` immediately.
     4. Poll every 1.5 s through `provider.poll` until terminal, with the controller's signal; save status changes.
     5. On `succeeded`, download each output through `provider.download`, then `addOutputs` with the bytes. Outputs that fail to download are recorded as an error on the run, without losing the others.
     6. A `VaultLockedError` or a generation change at any step ends the lifecycle without further writes or `set()` calls. The stored `providerRunId` lets `hydrate` resume.
     7. Other errors are saved on the run through a best-effort `updateRun` with its own catch.
   - `cancel(runId)`: awaits `provider.cancel(providerRunId)` (when known), then keeps polling until the provider reports a terminal status. Before the id is known, it marks the run `cancelRequested` and cancels as soon as `start` returns.
   - `remove(runId)`, `imageUrl(imageId)` / `releaseImageUrl(imageId)` with reference counting; at most 48 live URLs, least recently used revoked first.
   - `clear()`: aborts every controller, revokes every URL, resets state. It does not cancel predictions; they resume after unlock.
4. **Folder (`folder.ts`).**
   - `PLAYGROUND_FOLDER_ID = 'playground:folder'`.
   - `choosePlaygroundFolder()`: calls `window.showDirectoryPicker({ mode: 'readwrite' })` directly (not `pickWorkspace`, which writes the global handle at `src/workspace/handle.ts:35`), then `saveWorkspaceHandle(PLAYGROUND_FOLDER_ID, handle)`.
   - `restorePlaygroundFolder()` uses `restoreWorkspaceHandle(PLAYGROUND_FOLDER_ID)`.
   - `ensureFolderPermission(fs)` calls `fs.ensurePermission('readwrite')`. The view calls it first in the click handler, before any decrypt, so user activation is still valid.
   - `saveToFolder(fs, name, blob)` uses `uniqueUploadPath` and `writeWorkspaceBlob`.

## Verification

- `pnpm exec vitest run src/playground/store.test.ts src/playground/state.test.ts src/playground/folder.test.ts`
- With `installKey()` from `src/memory/store.test.ts` and a fake provider:
  - raw rows in both tables contain neither the prompt nor the image bytes; round-trip returns the same data; a tampered AAD fails;
  - `listRunMeta` does not read `db.playgroundImages` (spy on the table) and skips a corrupted row;
  - a new run past 200 runs or 1 GiB prunes the oldest, including failed and canceled runs, and removes their images;
  - `recover()` empties both tables and `db.fs`;
  - lifecycle: `starting` → `processing` → `succeeded` with stored outputs; `providerRunId` is saved before the first poll; failure stores the error;
  - cancel before the id is known cancels once `start` returns; cancel after waits for a terminal status;
  - lock mid-poll (`keyring.clear()`) stops without writes and without an unhandled rejection; after a new `installKey`, `hydrate` resumes the run and stores its output; a run older than the retention window becomes `expired`;
  - a Dexie `QuotaExceededError` (built through Dexie, not a hand-made DOMException) maps to `storage_full`;
  - the model cache and object URLs are cleared by `clear()`;
  - `choosePlaygroundFolder` writes `playground:folder` and never the `workspace` handle.
