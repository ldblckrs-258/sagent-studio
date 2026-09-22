---
title: "Phase 2: Local Retrieval"
status: done
---

# Phase 2: Local Retrieval

<!-- Updated: Validation Session 1 - bounded vector index with paged mode at the 1k-doc scale -->

## Context Links

- [`plan.md`](./plan.md) — acceptance criteria 2, 3, 8, and 9.
- [`phase-01-document-store-and-ingest.md`](./phase-01-document-store-and-ingest.md) —
  the record shape, AAD seeds, `ChunkRecord.dims`, `sweepOrphanChunks`, and `getChunkText`
  this phase consumes.
- [`research/researcher-02-harness-rag-integration.md`](./research/researcher-02-harness-rag-integration.md)
  §3 (`cosineSimilarity` is exported by `ai`), §5 unlock/lock lifecycle
  (`store.ts:263-307`, `session-provider.tsx:21-48`).
- [`research/researcher-01-typesafe-jev.md`](./research/researcher-01-typesafe-jev.md) §11
  recommendation 2 (retrieve and filter in code first).

## Overview

Turn the encrypted rows from phase 1 into a queryable local vector index and add the local
scan. The index decides its own mode from the vectors' total byte cost: when they fit
`RAG_VECTOR_MEMORY_BUDGET_BYTES` they are decrypted once per unlock into a resident
contiguous `Float32Array` with a chunk-id → offset map, stamped with the vault's
`unlockGeneration`; when they do not, it pages per document through a document-keyed cache
bounded by the same budget. Either way orphan chunks are swept and each vector is validated
against `ChunkRecord.dims`, and chunk text stays encrypted until a passage is shortlisted.
The index also exposes per-document mutation and eviction so ingest and delete can update it
without a re-unlock, and `src/rag/lifecycle.ts` owns the hydrate/abort/clear wiring as a
plain module so it is testable. A query is embedded remotely, then scored against the index
with the `ai` cosine helper.

## Key Insights

- `unlockGeneration` (`src/vault/store.ts:37`) is the epoch. `lock()` clears the keyring
  and bumps it (`store.ts:295-307`), so a read against a cache stamped with an older
  generation must refuse rather than serve vectors the key no longer covers. The epoch is
  the real safety mechanism; `clear()` is memory hygiene on top of it.
- `SessionProvider` mounts per unlock and disposes on lock (`session-provider.tsx:21-48`)
  because `UnlockedApp` is only mounted while unlocked (`src/App.tsx:59-64`). Hydration
  belongs in its mount effect and clearing in its cleanup, matching the existing
  best-effort hydration list. The cleanup must abort the hydrate's controller before it
  clears, or an in-flight batch can repopulate the index after shutdown; development
  `<StrictMode>` runs mount, unmount, and mount again, so the wiring has to survive one
  aborted hydrate. That wiring lives in `src/rag/lifecycle.ts` so it has a real test.
- `cosineSimilarity(vector1: number[], vector2: number[])` is exported by `ai`
  (`node_modules/ai/dist/index.d.ts:7930`) and its implementation reads operands by index
  and uses `.length`, so it is valid over a `Float32Array` despite the declared type.
  Store vectors as `Float32Array` to avoid boxing millions of numbers, pass them through
  one documented cast, and pin that assumption with a test so a future SDK change fails
  loudly instead of silently.
- Decrypting every chunk's text at unlock would hold the whole plaintext corpus in memory
  and multiply the unlock cost. Decrypt vectors only — one AES operation per chunk — and
  decrypt text per shortlisted passage at query time.
- A fresh query embedding requires the provider (acceptance criterion 8). Hydration,
  listing, reading, and the cosine scan all work with no network; only
  `embedQuery` needs it.
- Scale arithmetic at the stated target: 1,000 documents and about 50,000 chunks. At 384
  dimensions that is 50,000 × 384 × 4 ≈ 77 MiB of vectors, which fits the 128 MiB default
  budget and stays resident; at 1536 dimensions it is ≈ 307 MiB, which does not, so the
  index has to be able to page instead of assuming residency. The scan stays brute force and
  exact in both modes, which is why an ANN index remains a non-goal.
- `RAG_VECTOR_MEMORY_BUDGET_BYTES` (128 MiB default) is what makes the index design
  decidable rather than aspirational: hydrate compares it against `chunkCount × dims × 4`,
  and the same number bounds the paged mode's document cache, so both modes have a stated
  ceiling rather than unbounded growth.

## Requirements

- `hydrate({ onProgress, signal })` sweeps orphan chunks, builds the in-memory index, and
  records the generation it was built under, reporting progress while it works. It chooses
  the mode from the vectors' total byte cost (`chunkCount × dims × 4` against
  `RAG_VECTOR_MEMORY_BUDGET_BYTES`, default 128 MiB): within the budget it builds one
  resident contiguous `Float32Array` plus a chunk-id → offset map, and above it it enters
  paged mode, keeping a chunk-id → document-id index in memory and holding decrypted vectors
  only in a document-keyed LRU cache bounded by the same budget.
- Aborting or failing a hydrate clears only the partial state that call wrote, and clears
  the shared index only when its stamped generation still equals the generation the call
  started under; it must never clear a newer, valid hydrate.
- Every read validates the generation — `getVector`, `cosineTopK`, and the text-load path
  each call `requireIndex()` or compare the stamp immediately before use, not only once at
  entry.
- A per-chunk dimension mismatch between the index and the query embedding is a typed
  `RagIndexError`, not a silent zero score and not an `InvalidArgumentError` from
  `cosineSimilarity`. Hydrate reads each chunk's expected length from `ChunkRecord.dims`
  rather than decrypting the document blob.
- `addVectors(entries)`, `removeVectors(ids)`, and `removeDocument(docId)` let ingest and
  delete update the live index without a full re-unlock, and are defined for both modes.
- `clear()` empties the index and is safe to call repeatedly.
- `embedQuery` returns the remote embedding for a query string and accepts an
  `AbortSignal`.
- `cosineTopK` returns the highest-scoring chunk ids with scores, sorted descending, using
  `cosineSimilarity`. It stays exact in both modes — in paged mode it reads and decrypts the
  non-resident documents in bounded batches — and it reports which mode it used.
- The unlock/lock wiring hydrates and clears the index through `SessionProvider`, and
  `startRagIndex()` in `src/rag/lifecycle.ts` owns that wiring so it has automated
  coverage under the `node` test environment.

## Architecture

```
SessionProvider mount
  -> startRagIndex()               lifecycle.ts: owns the AbortController and the wiring
       -> ragIndex.hydrate({ onProgress, signal })
            sweep orphans, size the vectors (chunkCount x dims x 4) against
            RAG_VECTOR_MEMORY_BUDGET_BYTES, stamp the unlock generation
            resident: decrypt into one contiguous Float32Array + chunk-id -> offset map
            paged:    keep chunk-id -> document-id, hold decrypted document vectors in an
                      LRU bounded by the same budget
            validate each vector length against ChunkRecord.dims

every read (getVector, cosineTopK, text load)
  -> requireIndex()                immediately before use; throws when the stamp moved

retrieval.ts
  -> embedQuery(embedder, query)   remote; the only network step
  -> cosineTopK(vector, index, k)  local; exact in both modes, reports the mode it used
       resident: scan the contiguous Float32Array via ai cosineSimilarity
       paged:    scan resident rows, then read and decrypt non-resident documents in
                 bounded batches, keeping only the running top-k

ingest and delete (phase 5 store)
  -> addVectors(entries)           update the live index without a re-unlock
  -> removeDocument(docId)         evict a deleted document's vectors

SessionProvider cleanup / vault lock
  -> controller.abort(); ragIndex.clear()
       abort first, so an in-flight hydrate cannot write into the index after shutdown
```

## Related Code Files

Create:

- `src/rag/index-cache.ts` — `hydrate`, `clear`, `requireIndex`, `isHydrated`,
  `entryCount`, `mode`, `getVector`, `addVectors`, `removeVectors`, `removeDocument`,
  `RagIndexError`, `RAG_VECTOR_MEMORY_BUDGET_BYTES`.
- `src/rag/lifecycle.ts` — `startRagIndex()`, the single place the index is wired to the
  session lifecycle.
- `src/rag/retrieval.ts` — `embedQuery`, `cosineTopK`.
- `src/rag/index-cache.test.ts`
- `src/rag/lifecycle.test.ts`
- `src/rag/retrieval.test.ts`

Modify:

- `src/session/session-provider.tsx` — call `startRagIndex()` in the mount effect and its
  returned stop function in the cleanup, keeping the existing failure-collection behaviour,
  and abort before clearing.

## Implementation Steps

1. In `src/rag/index-cache.ts`, define `RagIndexError` with a message that distinguishes
   "not hydrated", "stale unlock generation", and "vector dimensions do not match", and
   export `RAG_VECTOR_MEMORY_BUDGET_BYTES` (default `128 * 1024 * 1024`, overridable through
   `import.meta.env.VITE_RAG_VECTOR_MEMORY_BUDGET_BYTES`). Hold module state as
   `{ generation: number, dims: number, mode: 'resident' | 'paged', ... }` with
   `generation: -1` and an empty index as the cleared state.
2. Implement `hydrate({ onProgress, signal })`: call `sweepOrphanChunks()` first, read every
   chunk id from `src/rag/store.ts` (which already joins against `documents`), and choose the
   mode from the vectors' total byte cost, `chunkCount * dims * 4`, against
   `RAG_VECTOR_MEMORY_BUDGET_BYTES`. Within the budget, build a resident contiguous
   `Float32Array` plus a chunk-id → offset map, decrypting in bounded batches (64 concurrent
   decrypts). Above it, enter paged mode: keep a chunk-id → document-id index in memory and
   hold decrypted vectors only in a document-keyed cache bounded by the same budget, filling
   it in bounded document batches. Record `useVaultStore.getState().unlockGeneration` taken
   before the first read. Validate each vector's length against its `ChunkRecord.dims`,
   which hydrate reads with the row — never against the encrypted document blob, and never
   against a provider response. After the last batch, re-read the generation; if it moved,
   clear the index and throw `RagIndexError`. If the signal aborts or a batch throws, delete
   only the entries this call wrote, then clear the shared index only when its stamped
   generation still equals the generation this call started under, so a newer valid hydrate
   is never destroyed. Call `onProgress({ done, total })` after each batch and check
   `signal.aborted` between batches.
3. Implement `requireIndex()` to compare the stamped generation with
   `useVaultStore.getState().unlockGeneration` and throw `RagIndexError` when it differs or
   when nothing is hydrated. Call it immediately before each use — in `getVector`, in
   `cosineTopK`, and in the phase 4 text-load path — not only once per query entry, so a
   lock that lands between the scan and the decrypt is caught. Implement `clear()` as a
   reset to the cleared state and make it idempotent. Implement `entryCount` (every chunk the
   index knows, resident or not), `isHydrated`,
   `mode()`, and a `getVector(id)` that reads the resident buffer directly and, in paged
   mode, loads and decrypts the owning document's batch into the cache before answering.
4. Implement the index mutators on the same module: `addVectors(entries)` inserts or
   replaces entries for a finished ingest, `removeVectors(ids)` deletes a set of chunk ids,
   and `removeDocument(docId)` evicts every vector whose chunk belongs to that document.
   Each mutator calls `requireIndex()` first, leaves the stamped generation untouched (the
   index is still the same unlock), and is a no-op when the index is not hydrated, because
   phase 5 calls it from the panel store without knowing the index state. In resident mode
   the mutators rebuild the contiguous buffer and its offset map from the current live set,
   and if that rebuild would exceed the budget the index drops to paged mode instead of
   exceeding it. In paged mode they edit the chunk-id → document-id index and drop the
   affected documents' cached batches, so the next scan re-decrypts them.
5. In `src/rag/retrieval.ts`, implement `embedQuery(model, text, { signal })` with `embed`
   from `ai`, returning `result.embedding` (the singular field — `embed` is not
   `embedMany`; see `phase-01` step 6). Reject an empty or whitespace-only query before
   calling the provider.
6. Implement `cosineTopK(query, k)` over the hydrated index using
   `cosineSimilarity` from `ai`, with one documented cast from `Float32Array` to the
   declared `number[]` parameter, wrapped so that a length mismatch — whether thrown by the
   SDK as `InvalidArgumentError` or returned as a non-finite score — is rethrown as
   `RagIndexError`. Call `requireIndex()` first. In resident mode scan the whole contiguous
   buffer. In paged mode scan the resident vectors, then read and decrypt the documents
   whose vectors are not resident in bounded batches, scoring each batch as it arrives and
   keeping only the running top-k, so the scan stays exact and never holds more than one
   batch plus the bounded document cache. Return the top-k with scores together with the
   mode used, so the caller can surface it in the result and the timing log. Clamp `k` to
   at least 1 and at most the entry count, and throw `RagIndexError` when `query.length`
   differs from the index dimension.
7. Keep text loading and passage composition out of this module: phase 4 composes passages
   from `getChunkText` after the Jev gate, so `retrieval.ts` stays a two-function module
   with no dependency on the Jev layer. The phase 4 text-load path calls `requireIndex()`
   immediately before each decrypt.
8. Add `src/rag/lifecycle.ts` exporting `startRagIndex(options?): Promise<() => void>`.
   It creates an `AbortController`, calls
   `ragIndex.hydrate({ onProgress, signal: controller.signal })`, and returns a `stop()`
   that aborts the controller **before** calling `ragIndex.clear()`; a second `stop()` is a
   no-op. Keeping the coupling in one plain module is what makes it testable under `node`,
   where there is no React effect runner.
9. In `src/session/session-provider.tsx`, call `startRagIndex()` in the mount effect's
   best-effort block, pushing a failure into the existing `failures` array so a hydration
   error shows the banner instead of a blank app, and call the returned stop function in
   cleanup next to `session.dispose()`. The abort must precede `clear()` so an in-flight
   hydrate cannot write into the index after shutdown. Note that `<StrictMode>` mounts,
   unmounts, and remounts the effect in development, so the first hydrate is aborted and a
   second starts; the generation stamp plus the abort check make that safe, and `stop()`
   must tolerate a double call.
10. Write the tests listed below, then run `pnpm test`, `pnpm lint`, and `pnpm build`.

## Todo

- [x] Implement the generation-stamped vector index with a typed error and the memory budget.
- [x] Implement `hydrate` with the orphan sweep, `dims` validation, bounded decrypt
      batches, the resident/paged mode decision, abort rollback, and progress.
- [x] Implement `addVectors`/`removeVectors`/`removeDocument` in both modes.
- [x] Implement `embedQuery` with an abort signal and input validation.
- [x] Implement `cosineTopK` over `cosineSimilarity` in both modes, reporting the mode and
      mapping a mismatch to `RagIndexError`.
- [x] Call `requireIndex()` immediately before every index read.
- [x] Add `src/rag/lifecycle.ts` and wire `startRagIndex()` into `SessionProvider`.
- [x] Add the three test files, including the 1,000-document/50,000-chunk timing
      measurement.
- [x] Make `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Success Criteria

- `src/rag/index-cache.test.ts` proves: hydration of real Dexie rows produces one vector
  entry per chunk with matching values; an orphan chunk with no `documents` row is swept and
  absent from the cache; `requireIndex()` throws after `useVaultStore.getState().lock()` has
  bumped the generation; `getVector` and `cosineTopK` each throw after that bump, not only
  `requireIndex()`; `clear()` empties the cache and is idempotent; a second `hydrate()` does
  not double-count; a dimension mismatch throws.
- `src/rag/index-cache.test.ts` also proves an aborted hydrate leaves the previously
  hydrated cache intact and removes only the entries its own call wrote, and that
  `addVectors`, `removeVectors`, and `removeDocument` change `entryCount` as expected and
  are no-ops before hydration.
- `src/rag/index-cache.test.ts` also proves the mode decision: vectors that fit the budget
  hydrate as `resident` with a contiguous index, vectors over the budget hydrate as `paged`
  with `mode()` reporting `paged`, and a paged `cosineTopK` returns the same top-k ids and
  scores as the resident scan over the same fixture.
- `src/rag/lifecycle.test.ts` proves `startRagIndex()` hydrates the cache, that its stop
  function aborts before clearing, that a second `stop()` is a no-op, and that a hydrate
  whose signal was aborted by `stop()` cannot add an entry afterwards.
- `src/rag/retrieval.test.ts` proves: `cosineTopK` matches a brute-force reference
  implementation on a seeded fixture; results are sorted descending and respect `k`;
  `cosineSimilarity` returns the same value for a `Float32Array` cast and for the
  equivalent `number[]`; a dimension mismatch throws `RagIndexError` rather than returning
  zeros or surfacing the SDK's `InvalidArgumentError`.
- `src/rag/retrieval.test.ts` writes the target-scale fixture — 1,000 documents and about
  50,000 synthetic chunks — through the real encrypted store, hydrates, and records the
  median scan time over five runs together with the mode it ran in, the dimensions, and the
  memory budget it respected. The assertion uses a generous ceiling so only an algorithmic
  regression fails, and the observed numbers are recorded in this phase's report to
  substantiate acceptance criterion 3.
- `pnpm build` succeeds and the app hydrates without an error banner on unlock.

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| Vectors stay in memory after a lock | The generation guard is re-checked immediately before every read, not just at query entry, so a stale index is unusable the moment `lock()` clears the keyring; `startRagIndex()`'s stop aborts the hydrate before clearing, and the browser checklist in phase 5 confirms the memory is freed |
| An aborted or failed hydrate destroys a valid index or leaves partial entries | The aborted call deletes only the entries it wrote, and it clears the shared index only when the stamped generation still matches the generation it started under |
| An in-flight hydrate writes into the index after the session shut down | The cleanup aborts the controller before calling `clear()`, and the batch loop checks `signal.aborted` between batches; the StrictMode mount-unmount-remount cycle is covered by `src/rag/lifecycle.test.ts` |
| The live index goes stale after an ingest or a delete | Ingest calls `addVectors` and delete calls `removeDocument`, so a deleted document's vectors are evicted rather than scored, with no full re-unlock; in resident mode a rebuild that would exceed the budget demotes the index to paged mode rather than overshooting |
| Unlock latency grows with the library | Only vectors are decrypted, in bounded batches, with progress reported; the mode is chosen from `chunkCount × dims × 4` before any decrypt, and the timing test in this phase measures hydration as well as the scan |
| A paged scan re-decrypts the same document repeatedly | The document-keyed cache keeps the most recently scored documents decrypted, each scan reads a document once per batch, and only the running top-k is retained, so scan memory stays flat |
| A timing assertion is flaky on a loaded machine | The test asserts a generous ceiling and records the median, the mode, the dimensions, and the budget; the target-scale measurement is the phase 5 manual run |
| The `Float32Array` cast breaks on an SDK upgrade | A test pins the behaviour of `cosineSimilarity` over a typed array, and a mismatch is remapped to `RagIndexError` |
| Resident memory grows past the stated ceiling on a large library | `RAG_VECTOR_MEMORY_BUDGET_BYTES` (128 MiB default) decides the mode at hydrate time and bounds the paged document cache, so paged mode has a stated ceiling; the phase 5 checklist records the measured memory and the budget it respected |

## Security Considerations

Decrypted vectors exist only in main-thread memory and only while unlocked — all of them in
resident mode, and in paged mode only the bounded document cache plus one scoring batch.
Chunk text is never held in a corpus-wide cache; it is decrypted per shortlisted passage, and that
decrypt re-checks the generation immediately before it runs, so a lock that lands mid-query
fails closed. The index mutators also re-check the generation, and `removeDocument` evicts a
deleted document's vectors so deleted content cannot be scored or cited from a stale index.
Hydration and the scan make no network calls, so the offline part of acceptance criterion 8
holds by construction. The query embedding itself is remote and reveals the query text to
the configured provider, which the tool guide and README must state. `ChunkRecord.dims` is
the only unencrypted per-chunk value the index reads, and it reveals embedding width only.

## Next Steps

Phase 3 builds the Jev judgment module that scores the top-k candidates this phase
returns. It does not depend on the index internals, so it can be implemented against a
candidate list and unit-tested with a mocked client.
