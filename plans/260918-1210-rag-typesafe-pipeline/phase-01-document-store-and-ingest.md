---
title: "Phase 1: Document Store and Ingest"
status: done
---

# Phase 1: Document Store and Ingest

<!-- Updated: Validation Session 1 - token-based chunking and explicit embedding pick -->

## Context Links

- [`plan.md`](./plan.md) — contract, constraints, acceptance criteria.
- [`research/researcher-02-harness-rag-integration.md`](./research/researcher-02-harness-rag-integration.md)
  §2 persistence (`db.ts:87-95`, `records.ts:19-33`, `store.ts:325-336, 361-373`), §3
  embeddings (`llm.ts:8-21`, `providers.ts:47-63`), §4 pdf.js and the CSP.
- [`research/researcher-01-typesafe-jev.md`](./research/researcher-01-typesafe-jev.md) §8
  documented limits (64k context, 32k state, 1,200 req/min), §11 recommendation 6.
- [`reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md`](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md)
  — vault model and chunking intent.

## Overview

Create the encrypted document store and the ingest path: two new Dexie tables, binary
record helpers that preserve the keyring-generation guard, a deterministic chunker, PDF
text extraction through the pdf.js worker, a remote embedder factory that reuses the
user's configured provider, and an ingest orchestrator with progress reporting. Nothing
in this phase judges or retrieves; it only makes a document exist as encrypted rows.

## Key Insights

- `encryptRecord`/`decryptRecord` are string-only (`src/vault/records.ts:19-33`), and
  vectors are binary. New helpers must be built on `encrypt`/`decryptBytes`
  (`src/vault/crypto.ts:86-131`) and must keep the `assertUnchanged` snapshot guard
  (`records.ts:12-17`), or a lock mid-write would silently land a blob with no key.
- Dexie's newest `version(n)` declaration restates every table, so `version(6)` must
  repeat the whole version-5 block plus the new tables (`src/vault/db.ts:87-95`).
- A document row and its chunk rows are one unit. `db.transaction('rw', db.documents,
  db.chunks, ...)` (or one `vaultWriteQueue` task that owns both) makes the two writes
  atomic, so no reader ever sees a document without its full chunk set. A transaction
  cannot survive a tab kill between the embed and the write, so an orphan-chunk sweep on
  unlock makes the store self-repairing, and that sweep needs `dims` on `ChunkRecord` so a
  vector can be validated without decrypting the document blob. `dims` is the only
  unencrypted per-chunk number and reveals embedding width, never content.
- Dexie fires `versionchange` on the open tab when another tab opens a higher version, and
  `blocked` on the upgrading tab. Without handlers, the stale tab keeps writing an old
  schema. `db.close()` on `versionchange` plus a surfaced "close other tabs" notice on
  `blocked` is the guard, and it belongs with the schema that introduces `version(6)`.
- `recover()` clears only the tables it names (`src/vault/store.ts:325-336`), and
  `vaultInternals.reset` names its own list (`store.ts:361-373`). Both need the new
  tables, or "start over" leaves orphaned encrypted documents that can never be opened.
- Embeddings stay a plain `number[]` from `ai` (`Embedding = Array<number>`), and
  `embedMany` auto-batches against the model's `maxEmbeddingsPerCall`, so this phase adds
  no chunking logic for the request body. `maxParallelCalls` is the SDK's own fan-out and
  is separate from `rag.concurrency`, which belongs to the Jev pool in phase 3.
- `resolveProvider` (`src/ai/providers.ts:47-63`) validates `baseURL`, `apiKey`, and that
  `defaultModel` names a listed model. Reusing it for embeddings keeps one validation path
  and one error type (`LLMConfigError`).
- The pdf.js library must not sit in the initial bundle: import `pdf.mjs` and the
  `?url` worker dynamically, so a user who never adds a PDF never downloads them.
- `rag.chunkSize` and `rag.overlap` are token counts, counted with `gpt-tokenizer`: a pure
  TypeScript BPE implementation (`cl100k_base`/`o200k_base`) with no wasm, so it is safe on
  the main thread under the production CSP, which allows no `wasm-unsafe-eval`
  (`vite.config.ts:41`). The chunker clamps `chunkSize` to `[MIN_CHUNK_TOKENS,
  MAX_CHUNK_TOKENS]` (64 and 1024). The upper clamp keeps one passage plus its Jev questions
  inside Jev's 32k-token state budget (researcher-01 §8), and 1024 tokens still leaves
  headroom under the embedding model's roughly 8k-token input limit once the overlap prefix
  is added. The lower clamp keeps a chunk long enough to carry evidence. Defaults are 400
  tokens with a 60-token overlap (about 15%).
- Titles are encrypted with everything else. The library panel is only mounted while
  unlocked, so nothing needs to render before decryption, and acceptance criterion 2
  ("a wrong password reveals nothing") rules out plaintext metadata.

## Requirements

- A `documents` table stores one encrypted record per document: title, kind, source
  filename, byte size, chunk count, chunking parameters, embed model and provider id,
  vector dimensions, and timestamps.
- A `chunks` table stores one encrypted record per chunk with the chunk text and the
  vector, each as its own `EncryptedBlob`, plus a plaintext `dims` number for the vector
  length so hydration can validate dimensions without decrypting the document blob. `dims`
  is an opaque shape number and carries no content.
- One `db.transaction('rw', db.documents, db.chunks, ...)` (or one `vaultWriteQueue` task)
  writes a document's chunks and its document record atomically: no reader can observe a
  document without its full chunk set, and no chunk can exist without its document.
- `listChunkIds` joins against `documents`, and an orphan-chunk sweep runs on unlock and on
  hydrate: any chunk whose `docId` has no `documents` row is deleted. This is the repair
  path for a crash or a quota failure that outran the transaction.
- No plaintext document content, title, or vector bytes anywhere in IndexedDB.
- Chunking is deterministic for identical input and parameters, and it counts tokens rather
  than characters: `chunkText` measures with `gpt-tokenizer`, `rag.chunkSize` and
  `rag.overlap` are token counts, and `chunkSize` is clamped to `[64, 1024]` tokens.
- Extraction is bounded: `MAX_EXTRACTED_CHARS = 1_000_000` characters of extracted text and
  `MAX_FILE_BYTES = 25 * 1024 * 1024` per file, enforced in `extractPdfText` (and at the
  ingest entry for every kind) before chunking, with a readable error that names the limit.
  Chunk-and-encrypt must not pin the main thread: the loop yields with a macrotask boundary
  (`await new Promise((resolve) => setTimeout(resolve, 0))`) every 32 chunks.
- Ingest works for `text/plain`, `text/markdown`, and `application/pdf`, runs off the main
  thread for PDF, and reports progress.
- A failed ingest leaves no partially written document behind.
- `src/vault/db.ts` handles Dexie `versionchange` by calling `db.close()`, and `blocked` by
  surfacing a "close other tabs" notice, so a schema upgrade from a second tab cannot
  silently leave this tab writing against an old schema.
- `createEmbedder(settings, providerId?)` returns an `EmbeddingModel` built from the
  configured provider, with no new cache entry in `src/ai/client-cache.ts`.
- Removing a document removes its chunks.
- `rag.embedProviderId` and `rag.embedModel` are the embedding target the user picks
  explicitly in the Documents panel (phase 5). The fallback that resolves an absent
  `embedProviderId` to the first configured provider only seeds that control before the
  first explicit pick; it is never a silent selection.
- A one-item `embedMany` probe runs before the first ingest of a run and, when the endpoint
  serves no embedding model, fails the ingest with a clear, actionable error naming the
  resolved provider id, the embed model, and the provider configuration to fix.

## Architecture

```
addDocuments(files)
  -> per file: reject over MAX_FILE_BYTES (25 MiB)
     extract text (text/markdown inline, PDF via pdf.js worker)
     reject over MAX_EXTRACTED_CHARS (1,000,000) before chunking
  -> chunkText(text, { chunkSize, overlap })     tokens via gpt-tokenizer; [64, 1024] clamp
  -> embedPassages(embedder, chunkTexts)      embedMany, remote, auto-batched
                                             (one-item probe precedes the first ingest run)
  -> encryptRecord(meta, `doc:${docId}`)                existing string helper
     encryptRecord(text, `doc-chunk-text:${chunkId}`)   existing string helper
     encryptRecordBytes(vecBytes, `doc-chunk-vector:${chunkId}`)  new binary helper
     ChunkRecord.dims = embedding.length                plaintext vector length
  -> yield every 32 chunks (macrotask boundary)
  -> db.transaction('rw', db.documents, db.chunks, ...)
       chunks.bulkPut(chunks); documents.put(meta)      one atomic unit
  -> unlock/hydrate sweeps any chunk whose docId has no document
```

## Related Code Files

Create:

- `src/rag/types.ts` — `DocumentKind`, `DocumentMeta`, `ChunkDraft`, `StoredChunk`,
  `IngestProgress`, `IngestResult`.
- `src/rag/chunker.ts` — `chunkText(text, options)` counting tokens with `gpt-tokenizer`,
  `MIN_CHUNK_TOKENS`, `MAX_CHUNK_TOKENS`.
- `src/rag/pdf.ts` — `loadPdf(data)` (dynamic imports and worker wiring),
  `extractText(pdf, signal)`, `extractPdfText(data, signal)`, `MAX_EXTRACTED_CHARS`
  (1,000,000) and `MAX_FILE_BYTES` (25 MiB), the two caps `ingest.ts` imports.
- `src/rag/store.ts` — `saveDocument`, `listDocuments`, `getDocument`, `deleteDocument`,
  `putChunks`, `listChunkIds`, `getChunkRecord`, `getChunkText`, `countChunks`,
  `sweepOrphanChunks`.
- `src/rag/ingest.ts` — `ingestDocument(input)`, `ingestFiles(input)`.
- `src/ai/embedder.ts` — `createEmbedder(settings, providerId?)`, `embedPassages`,
  `probeEmbedding(model, { signal })`.
- `src/rag/chunker.test.ts`
- `src/rag/pdf.test.ts`
- `src/rag/store.test.ts`
- `src/rag/ingest.test.ts`
- `src/ai/embedder.test.ts`

Modify:

- `src/vault/db.ts` — `DocumentRecord` and `ChunkRecord` interfaces (with `dims`),
  two `Table` fields, `version(6).stores({ ... })`, and the `versionchange`/`blocked`
  handlers.
- `src/vault/records.ts` — `encryptRecordBytes(plaintext, aadSeed)` and
  `decryptRecordBytes(blob, aadSeed)`, both keeping the `assertUnchanged` guard.
- `src/vault/store.ts` — add `db.documents` and `db.chunks` to the `recover()`
  transaction and clears (`325-336`) and to `vaultInternals.reset` (`361-373`).
- `src/vault/settings.ts` — add optional `embedProviderId?: string` to `RagSettings`, set
  `rag.concurrency` to `4` in `defaultSettings()` to match the documented pool, change
  `chunkSize` from `1000` to `400` and `overlap` from `200` to `60` (both are token counts
  now, about 15% overlap), and add a short comment that an absent `embedProviderId` only
  seeds the Documents panel control and means "first configured provider" until the user
  picks one (`src/vault/settings.ts:132-137`).
- `src/vault/settings.test.ts` — the `migrate` test asserts the default `rag.concurrency`
  at line 133; update that expectation from `2` to `4` to match the new default. The
  chunk-size line at 95 asserts `base.rag.chunkSize` rather than a literal, so the new
  400/60 defaults need no edit there.
- `src/vault/test-fixtures.ts` — the shared fixture pins `chunkSize: 1000` and `overlap:
  200` (lines 53-54) and `concurrency: 2` (line 57). Update it to `400`, `60`, and `4` so
  fixtures keep mirroring `defaultSettings()` and no test asserts a value the product no
  longer produces.
- `package.json` — `pnpm add --save-exact pdfjs-dist@6.3.289` and `pnpm add gpt-tokenizer`.

## Implementation Steps

1. Install the pdf.js pin exactly with `pnpm add --save-exact pdfjs-dist@6.3.289` and add
   the chunking dependency with `pnpm add gpt-tokenizer`, then verify the pdf.js package's
   `exports` map in `node_modules/pdfjs-dist/package.json` actually exposes the
   subpaths used in step 4 (`pdf.min.mjs` and `pdf.worker.min.mjs`, the minified builds).
   Write the dynamic import only against an exported path; if a minified subpath is not
   exported, use the documented exported equivalent — `build/pdf.mjs` for the library or
   `build/pdf.worker.mjs` for the worker — instead of guessing, and record the paths chosen
   in the phase report.
2. In `src/vault/db.ts`, add `DocumentRecord { id, blob: EncryptedBlob, updatedAt }` and
   `ChunkRecord { id, docId, ordinal, dims, text: EncryptedBlob, vector: EncryptedBlob,
   updatedAt }`. Declare the matching `documents!: Table<DocumentRecord, string>` and
   `chunks!: Table<ChunkRecord, string>` fields, then add `version(6).stores({ ... })`
   repeating every version-5 table plus `documents: 'id, updatedAt'` and
   `chunks: 'id, docId, [docId+ordinal]'`. Also register `db.on('versionchange', () =>
   db.close())` and have the blocked path surface a "close other tabs" notice, so a second
   tab upgrading to v6 cannot leave this tab writing an old schema.
3. In `src/vault/records.ts`, add `encryptRecordBytes` and `decryptRecordBytes` by
   mirroring `encryptRecord`/`decryptRecord`: snapshot the keyring, throw
   `VaultLockedError` when no key is installed, call `encrypt`/`decryptBytes` with
   `aadFor(aadSeed)`, and call the existing `assertUnchanged` before returning. Do not
   change the string helpers.
4. In `src/rag/pdf.ts`, declare `MAX_EXTRACTED_CHARS = 1_000_000` and
   `MAX_FILE_BYTES = 25 * 1024 * 1024`, and implement `loadPdf(data)` with dynamic imports
   only: `const pdfjs = await import('pdfjs-dist/build/pdf.min.mjs')` and
   `const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default`,
   assign `pdfjs.GlobalWorkerOptions.workerSrc = workerUrl`, then
   `pdfjs.getDocument({ data })` — on the paths verified in step 1. Implement
   `extractText(pdf, signal)` as a pure function over a document-like object that walks
   pages, joins `getTextContent()` items, checks `signal.aborted` between pages, and calls
   `pdf.destroy()` on the abort path. Accumulate extracted characters and throw a readable
   limit error as soon as the running total passes `MAX_EXTRACTED_CHARS`, so an oversized
   PDF is stopped during extraction rather than after it. `extractPdfText` composes the two
   and is the enforcement point named in the Requirements.
5. In `src/rag/chunker.ts`, implement text extraction in this order: split on blank lines
   into blocks, keep markdown headings attached to the block that follows, count tokens with
   `gpt-tokenizer` (`encode`/`decode`, or the exported token-count helper, over the
   `cl100k_base`/`o200k_base` BPE — pure TypeScript, no wasm, so it is safe on the main
   thread under the CSP), accumulate blocks up to `chunkSize` tokens, and start each chunk
   with an overlap of the trailing `overlap` tokens of the previous one. Clamp `chunkSize`
   to `[MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS]` (64 and 1024) and reject
   `overlap >= chunkSize`. Return `ChunkDraft { ordinal, text }`. Return an empty array for
   blank input.
6. In `src/ai/embedder.ts`, implement `createEmbedder(settings, providerId?)` using
   `resolveProvider(settings.providers, providerId ?? settings.rag.embedProviderId ??
   settings.providers[0]?.id ?? '')`, `createOpenAICompatible({ baseURL, name, apiKey })`,
   and `.embeddingModel(settings.rag.embedModel.trim())`, throwing `LLMConfigError` for a
   blank embed model. That fallback only seeds the control: the Documents panel passes the
   provider and model the user picked, which is what gets resolved here. Implement
   `probeEmbedding(model, { signal })` as a one-item `embedMany` that returns the vector's
   dimension and, when the endpoint serves no embedding model, throws an error whose message
   names the resolved provider id, the embed model, and the provider configuration to fix;
   the first ingest of a run calls it before reading any file. Implement
   `embedPassages(model, texts, { maxParallelCalls, signal })`
   as a thin `embedMany` wrapper returning `{ embeddings, usage }`: `embeddings` is
   `number[][]` in input order, and `usage` is the `EmbeddingModelUsage` the SDK returns,
   which carries `tokens` only (`node_modules/ai/dist/index.d.ts:374-378`). There is no
   dimension on a usage object; callers take dimensions from `embeddings[0].length`.
7. In `src/rag/store.ts`, define AAD seeds as `doc:${id}`, `doc-chunk-text:${chunkId}`,
   and `doc-chunk-vector:${chunkId}`, and implement the save/list/get/delete helpers over
   `db.documents` and `db.chunks`. Chunk text and document metadata use the existing string
   helpers `encryptRecord`/`decryptRecord`; only the vector goes through
   `encryptRecordBytes`/`decryptRecordBytes`. Convert vectors with
   `new Float32Array(embedding)` and encrypt the underlying bytes; write
   `ChunkRecord.dims = embedding.length`, and on decrypt rebuild `Float32Array` from the
   byte buffer and check its length against `dims` before returning. Implement
   `listChunkIds()` so it joins `db.chunks` against `db.documents` and never yields a chunk
   whose document is missing, and implement `sweepOrphanChunks()` to delete exactly those
   chunk ids (`db.chunks.where('docId').noneOf(docIds).delete()` or the equivalent filtered
   delete) for the unlock and hydrate repair path. Expose `getChunkText(id)` so retrieval
   can decrypt one shortlisted passage without loading the corpus text. Every write helper
   snapshots `keyring.getKey()` before entering `vaultWriteQueue` and re-checks the same key
   inside the queued task, mirroring `useVaultStore.update` (`src/vault/store.ts:309-320`),
   so a lock that lands mid-ingest cannot write rows under a cleared key.
8. In `src/rag/ingest.ts`, implement
   `ingestDocument({ id?, file, text?, embedder, chunkSize, overlap, embedProviderId,
   embedModel, signal, onProgress })`. Generate ids with `crypto.randomUUID()`. Reject a
   file over `MAX_FILE_BYTES` before reading it and re-check the extracted text length
   against `MAX_EXTRACTED_CHARS` before chunking. Emit `onProgress({ phase, done, total })`
   for `extracting`, `chunking`, `embedding`, and `persisting`. Yield to the macrotask queue
   every 32 chunks (`await new Promise((resolve) => setTimeout(resolve, 0))`) so the
   synchronous chunk-and-encrypt loop cannot pin the main thread. Persist the chunk rows and
   the document record in one atomic unit — a single
   `db.transaction('rw', db.documents, db.chunks, ...)` (or one `vaultWriteQueue` task that
   performs both writes) — so an observer can never see a document without its chunks or
   chunks without their document; on any failure delete every chunk written for that
   document id as a belt-and-braces repair, since the sweep is the durable net. Implement
   `ingestFiles` as a sequential loop that reports per-file results without aborting the
   whole batch, and have it call `probeEmbedding` once before the first file so a provider
   that serves no embedding model fails with the named-provider error instead of writing
   rows.
9. In `src/vault/store.ts`, add `db.documents` and `db.chunks` to the `recover()`
   transaction's table list and its clear calls, and add equivalent clears to
   `vaultInternals.reset`. The orphan sweep is invoked from the phase 2 hydrate/unlock
   wiring rather than from the vault layer, so `src/vault` keeps no dependency on `src/rag`;
   phase 1 only exports `sweepOrphanChunks`.
10. Write the tests listed below, then run `pnpm test`, `pnpm lint`, and `pnpm build`.

## Todo

- [x] Install `pdfjs-dist@6.3.289` with `--save-exact` and `gpt-tokenizer`, and verify the
      pdf.js `exports` map.
- [x] Add `documents` and `chunks` to Dexie as `version(6)`, with `dims` on `ChunkRecord`.
- [x] Add the `versionchange`/`blocked` handlers and the "close other tabs" notice.
- [x] Add `encryptRecordBytes`/`decryptRecordBytes` with the generation guard.
- [x] Implement `pdf.ts` with dynamic imports, a pure `extractText` seam, and the caps.
- [x] Implement `chunker.ts` with token counting, clamps, overlap, and heading handling.
- [x] Implement `createEmbedder`, `probeEmbedding`, and `embedPassages`.
- [x] Implement `store.ts` CRUD with per-record AAD seeds, key re-assert, and the sweep.
- [x] Implement `ingest.ts` atomic write, the pre-batch probe, progress, yield boundary, and
      failure cleanup.
- [x] Extend `recover()` and `vaultInternals.reset` with the new tables.
- [x] Add `rag.embedProviderId`, set `rag.concurrency` to 4 and `chunkSize`/`overlap` to
      400/60 tokens, and update `settings.test.ts:133` and `test-fixtures.ts:53-57`.
- [x] Add the five test files and make `pnpm test`, `pnpm lint`, `pnpm build` pass.

## Success Criteria

- `src/rag/chunker.test.ts` proves identical input yields identical chunks, that overlap
  is applied, that a heading stays with its following block, that chunk sizes are measured
  in tokens and stay within `[MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS]`, and that out-of-range
  parameters are rejected.
- `src/rag/store.test.ts` round-trips a chunk's text and vector bit-exactly, proves a
  unique plaintext marker does not appear in the raw Dexie row or in
  `JSON.stringify(row)`, and proves every read path throws `VaultLockedError` once the
  keyring is cleared.
- `src/rag/ingest.test.ts` proves a two-file ingest produces the expected chunk counts,
  emits the progress phases in order, leaves no rows when the embedder throws, and
  persists a document that `listDocuments()` returns after reopening the table. It also
  proves the write is atomic — a failure forced inside the write leaves neither a document
  row nor chunk rows — and that `sweepOrphanChunks()` deletes a deliberately planted orphan
  chunk while leaving valid chunks alone.
- `src/ai/embedder.test.ts` proves provider resolution, that a blank embed model raises
  `LLMConfigError`, that `embedPassages` returns vectors in input order plus the
  tokens-only usage from a stubbed model, and that `probeEmbedding` returns the dimension
  and raises an error naming the provider and the model when the endpoint serves no
  embedding model.
- `src/rag/pdf.test.ts` proves `extractText` joins page text in page order and stops on an
  aborted signal, using a fake document object, and that `extractPdfText` throws the
  readable limit error once the running character total passes `MAX_EXTRACTED_CHARS`.
  `ingest.test.ts` proves a file over `MAX_FILE_BYTES` is rejected before it is read.
- `src/vault/settings.test.ts` asserts the new `rag.concurrency` default of `4` at the
  `migrate` expectation; its `chunkSize` assertion at line 95 compares against
  `base.rag.chunkSize` rather than a literal, so the new token defaults are covered by
  `src/vault/test-fixtures.ts` carrying `400` and `60`.
  The `versionchange`/`blocked` handlers are exercised by the phase 5 two-tab checklist
  case rather than a unit test, because `fake-indexeddb` does not reproduce a second-tab
  schema upgrade.
- `pnpm build` succeeds with no pdf.js module in the entry chunk and the tokenizer confined
  to the chunker's own module.

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| A lock lands mid-ingest and a blob is written under a cleared key | Every write goes through the guarded helpers and `vaultWriteQueue`; the write task captures the keyring identity before it is queued and re-checks it inside the task, mirroring `useVaultStore.update` (`store.ts:309-320`), and the failure path deletes partial rows |
| A crash or quota failure leaves orphan chunks or a document without its chunks | One read-write transaction covers both writes; `sweepOrphanChunks()` on hydrate/unlock deletes chunks whose `docId` has no document, and `listChunkIds()` joins against `documents` so a caller never sees a chunk without its document |
| A hostile PDF reaches the worker's network egress and IndexedDB from attacker-controlled bytes | The worker is same-origin, does not inherit the document CSP, and has page-equivalent egress; the defence is key isolation — the vault key never enters the worker and decrypted text is never posted to it — and the residual risk is accepted, recorded here, and re-checked by the phase 5 hostile-PDF case |
| A schema-version mistake corrupts an existing vault | `version(6)` restates every earlier table verbatim; `pnpm test` runs the vault suite against `fake-indexeddb`; a second tab on v5 is handled by `db.close()` on `versionchange` and a "close other tabs" notice on `blocked`, with the two-tab upgrade case in the phase 5 checklist |
| Provider has no embedding model or reports unexpected dimensions | `probeEmbedding` runs a one-item `embedMany` before the first write and fails with a message naming the resolved provider id, the embed model, and the fix; `dims` is stored on every chunk and a mismatch is rejected on read |
| A chunk plus its Jev questions overflows the 32k-token state budget | `chunkSize` is clamped to `[64, 1024]` tokens, so one passage plus the five grading questions stays well inside Jev's state budget, and 1024 tokens still leaves headroom under the embedding model's roughly 8k-token input limit once the 60-token overlap prefix is added |
| The tokenizer dependency bloats the entry bundle or blocks the main thread | `gpt-tokenizer` is pure TypeScript with no wasm, is imported only by `chunker.ts`, and the chunk loop already yields a macrotask every 32 chunks; the phase 5 build check confirms no pdf.js or tokenizer module lands in the entry chunk |
| pdf.js worker cannot load under the production CSP | Dynamic same-origin worker, verified in the phase 5 browser checklist; `extractText` is unit-tested independently of the worker |
| Large PDFs exhaust memory or the storage quota | `MAX_FILE_BYTES` (25 MiB) is enforced before reading and `MAX_EXTRACTED_CHARS` (1,000,000) during extraction, before chunking; the chunk loop yields every 32 chunks so the main thread stays responsive; `QuotaExceededError` is surfaced as a readable error and progress keeps a long ingest visible |

## Security Considerations

Titles, text, and vectors are all encrypted, so a wrong password reveals nothing. AAD
domain separation per record keeps a blob from being replayed under another chunk's seed.
The vault key never leaves the main thread, and the pdf.js worker receives raw PDF bytes
only — never a key and never decrypted text. That worker is still a new attack surface:
it is same-origin, does not inherit the document CSP, has the page's network egress, and
can open IndexedDB, so a hostile PDF runs against the worker's own capability set. The
defence is key isolation, not cryptography inside the worker; the residual risk is accepted
and recorded, and the phase 5 checklist includes a hostile-PDF case.

Ingest sends chunk text to the configured embedding provider over the network; that is
inherent to the chosen design and must be stated in the tool guide and the README
data-egress section. Vector bytes are never logged or written to a plaintext table. The
only unencrypted per-chunk field is `dims`, an embedding width.

Every ingest write re-checks keyring identity: the helper captures `keyring.getKey()`
before it enters `vaultWriteQueue` and compares the same key inside the queued task before
the Dexie ops, mirroring `useVaultStore.update` (`store.ts:309-320`). A lock that lands
mid-ingest therefore throws `VaultLockedError` instead of landing rows under a cleared key,
and the guarded record helpers (`assertUnchanged`) cover the encrypt step that precedes the
write.

## Next Steps

Phase 2 decrypts the vector blobs written here into a generation-guarded in-memory index —
resident when they fit `RAG_VECTOR_MEMORY_BUDGET_BYTES`, paged per document when they do
not — and scans them with `cosineSimilarity`, reading `ChunkRecord.dims` for validation and
calling `sweepOrphanChunks()` on hydrate and unlock. Do not begin it until the store
round-trip, atomicity, and lock tests pass, because the index depends on the exact record
shape, the `dims` field, and the AAD seeds fixed in this phase.
