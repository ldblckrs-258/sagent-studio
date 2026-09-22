---
title: "Encrypted Document Library + Jev-Gated Retrieval"
description: "A user-managed, encrypted local document library (text/markdown/PDF) with remote embeddings, cosine retrieval, and Jev judgment tools driven by the agent loop"
status: in-progress
priority: P1
effort: 36h
branch: feat/token-metering-and-compaction
tags: [feature, frontend, ai, rag, security]
blockedBy: []
blocks: []
created: 2026-09-22
---

# Encrypted Document Library + Jev-Gated Retrieval

## Overview

This plan adds a separate, user-managed document library to the encrypted vault and
gives the model read-only tools over it. A user adds text, markdown, or PDF files; each
document is chunked by token, embedded through the provider and model the user picks, and
persisted as encrypted text and vector blobs in IndexedDB. Vectors are decrypted into an
in-memory index only while the vault is unlocked — resident in one buffer when they fit the
memory budget, paged per document when they do not. The model drives retrieval agentically:
it calls `search_documents`, which routes the query and grades candidate passages with Jev
before anything reaches the prompt. The user owns the corpus; the agent never mutates it.

This plan supersedes the earlier draft in this directory. Embeddings are remote through the
user's configured provider rather than `@huggingface/transformers`, and PDF is now in scope.

## Contract

**Outcome.** A user unlocks the vault, adds text/markdown/PDF documents to an encrypted
local library, and asks questions. The model retrieves agentically through harness tools;
Jev supplies judgments that gate, rank, and verify; every threshold and routing decision
stays in code.

**Constraints.**

- Index, storage, and cosine scan are local and encrypted at rest. Embeddings are remote
  through the existing configured provider: `@ai-sdk/openai-compatible`
  `.embeddingModel(id)` plus `ai@7` `embedMany`, which auto-batches and takes
  `maxParallelCalls`. No `@huggingface/transformers`, no server component.
- `embed()` resolves to a single `embedding`; `embedMany()` resolves to `embeddings` in
  input order; `EmbeddingModelUsage` exposes only `tokens`
  (`node_modules/ai/dist/index.d.ts:374-378`), never a dimension. Dimensions come from a
  one-item probe at the first ingest and are stored on each `ChunkRecord` as `dims`;
  nothing may derive a dimension from a usage or result object.
- One ingest writes a document's chunk rows and its `documents` row in a single Dexie
  read-write transaction over `db.documents` and `db.chunks` (or one `vaultWriteQueue` task
  that owns both), so an interrupted ingest can never leave orphan chunks or a document
  without its full chunk set. The live vector index is updated or evicted on ingest and on
  delete, not only at unlock: ingest calls `addVectors`, delete calls
  `removeDocument`/`removeVectors`.
- Chunking counts tokens, not characters: `src/rag/chunker.ts` measures with
  `gpt-tokenizer`, `rag.chunkSize` and `rag.overlap` are token counts (defaults 400 and 60),
  and `chunkSize` is clamped to `[64, 1024]` tokens so a passage plus its Jev questions stays
  inside the 32k-token state budget and inside the embedding model's input limit.
- Every Jev and embedding call receives an `AbortSignal` sourced from the tool execution
  options (`execute(input, { abortSignal })`) and threaded through
  `RagPort.search/getChunk/verifyCitation` into `embedQuery`, `gradePairs`, and each
  `systemOne({ ... }, { signal })`. A cancelled turn aborts every in-flight call.
- `resolveThresholds` clamps every known threshold override (`injectionMax`,
  `contradictsMin`, `relevantMin`, `evidenceMin`, `autoAccept`, `needsRetrievalMin`,
  `premiseValidMin`) to `[0, 1]`; only `concurrency` is clamped to `[1, 8]`. Unknown keys
  pass through untouched.
- Jev is judgment-only (Choice/Noul/Score) and never generates text.
- One `client.systemOne({ state, questions })` request evaluates many independent
  questions over one state in parallel. Passages cannot be batched into one request for
  pairwise questions: use one request per pair behind a bounded worker pool (about 4)
  with a cache keyed by `sha1(query + passageId)`.
- All routing thresholds live in one `THRESHOLDS` object in code, so a policy change costs
  no API calls. The cache stores raw answers, and routing re-reads them.
- Jev limits to design around: 64k tokens per request; 32k for state plus the longest
  question; 255 Choice options; 2-10 Score levels; text only; a 10s default timeout with
  `maxRetries: 2`; about 1,200 requests/minute. Set an explicit longer timeout and pass an
  `AbortSignal`. `dangerouslyAllowBrowser: true` is already set in `src/ai/typesafe.ts`.
- Confidence is not correctness, Noul carries no separate confidence, and a threshold
  calibrated on one question type is never reused on another.
- `search_documents` returns chunk `id` and `docTitle` so citations resolve to Dexie
  records. Every passage is untrusted text.
- `rag.embedProviderId` and `rag.embedModel` are the embedding target and the user picks
  them explicitly in the Documents panel: the provider selector and the model input default
  to the first configured provider and `settings.rag.embedModel`, and the picked values are
  persisted back to `rag.embedProviderId`/`rag.embedModel`. The fallback that resolves an
  absent `embedProviderId` to the first configured provider only seeds that control before
  the first explicit pick; it is never a silent selection. Before the first ingest, a
  one-item `embedMany` probe runs against the selected provider and model and, when the
  endpoint serves no embedding model, fails with a clear, actionable error naming the
  provider. Existing `rag` fields are kept.
- New dependency `pdfjs-dist`, installed exact (`pnpm add --save-exact
  pdfjs-dist@6.3.289`) and loaded on demand in a same-origin Vite worker. Before writing
  the dynamic import, verify the package `exports` map actually exposes the chosen
  `pdf.mjs` / `pdf.worker.min.mjs` subpaths; if the minified subpath is not exported, use
  the documented exported path rather than guessing. `worker-src 'self'` already permits
  the worker and main-thread wasm is blocked by the CSP.
- Threat model for that worker: a pdf.js worker is same-origin, does not inherit the
  document CSP, has page-equivalent network egress, and can open IndexedDB, so parsing
  attacker-controlled PDF bytes is a new attack surface. The defence is not cryptographic
  (the vault key never enters the worker); the residual risk is accepted and recorded, and
  phase 5 carries a hostile-PDF checklist case.

**Non-Goals.** ANN or approximate nearest-neighbour index. DOCX or HTML parsing.
Server-side retrieval or embedding. Agent create/update/delete over the corpus. TypeSafe
as a generator. Per-field encrypted querying inside Dexie. Password recovery.

**Acceptance Criteria.**

1. Adding a text, markdown, or PDF document chunks, embeds, encrypts, and persists it
   across reload, with no plaintext content and no plaintext vectors in IndexedDB.
2. A wrong password reveals nothing, and stored vectors are unreadable at rest.
3. At the target scale of 1,000 documents / ~50,000 chunks, top-k local retrieval excludes
   network embedding and stays within a measured budget recorded in phase 5; resident mode
   targets well under ~150 ms median, and a paged mode records its own measured median and
   the memory budget it respected.
4. A false-premise query routes to `conflicting_evidence` and the model reports the
   conflict instead of fabricating an answer.
5. A plain hidden instruction is filtered before reaching the LLM. This is best-effort;
   the bypass class is documented, not claimed solved.
6. A hallucinated or contradicted citation is flagged by `verify_citation`.
7. Passages entering the prompt drop measurably versus ungated retrieval.
8. The encrypted index persists and is readable offline; a new query embedding requires
   the provider. This supersedes the earlier "offline retrieval still functions".
9. Locking the vault clears keys and decrypted vectors from memory.

## Architecture

Ingest, user-initiated per document:

```
File (text | markdown | PDF)
  -> extract text        text/markdown read in the page; PDF via the pdf.js worker
  -> chunk, then embed   heading/paragraph aware, chunkSize tokens via gpt-tokenizer;
                         remote embedMany batches
  -> encrypt, then store AES-GCM: one text blob + one Float32 vector blob per chunk -> Dexie v6
```

Query, agent-initiated through `search_documents`:

```
question -> model decides to retrieve
  -> routeQuery({ query, context? })   Jev, ONE request: needs_retrieval + premise_valid
       needs_retrieval <= 0.5              -> skip retrieval
       premise_valid  <= 0.5 with context  -> conflicting_evidence
       no context (the tool path today)    -> the early exit is inert; the scan proceeds
  -> selectQuery    Jev Choice over code-generated candidate formulations
  -> embedQuery     remote, same provider
  -> cosine top-k   resident Float32 index via ai cosineSimilarity, or a paged scan of
                    non-resident documents in bounded batches when the vectors exceed
                    RAG_VECTOR_MEMORY_BUDGET_BYTES; exact either way, and it reports the mode
  -> gradePair x k  Jev, ONE request per pair (5 questions), pool of 4, cached
       route() in code -> include | conflicting_evidence | exclude
       contradicts_premise > 0.70 -> the primary false-premise path
  -> gated passages { id, docTitle, ordinal, score, text } reach the prompt
  -> model answers; verify_citation checks a claim against a chunk id
```

`routeQuery` takes `{ query, context? }`: `premise_valid` compares the query's premise
against a caller-supplied conversation context. When no context is supplied — which is the
tool path today, because the tool passes `{ query }` and no literal placeholder — the early
`premise_valid` exit is inert and retrieval proceeds. The primary false-premise path is
`gradePair`'s `contradicts_premise` Noul over the retrieved candidates, which routes the
pair to `conflicting_evidence`.

## Phases

| # | Phase | Effort |
| --- | --- | --- |
| 1 | [Document store and ingest](./phase-01-document-store-and-ingest.md) | 8h |
| 2 | [Local retrieval](./phase-02-local-retrieval.md) | 7h |
| 3 | [Jev judgment module](./phase-03-jev-judgment-module.md) | 7h |
| 4 | [RAG tools and session wiring](./phase-04-rag-tools-and-session-wiring.md) | 6h |
| 5 | [Library panel and end-to-end verification](./phase-05-library-panel-and-end-to-end-verification.md) | 8h |

Phases run in order. Phase 1 owns the schema and record helpers, phase 2 owns the vector
index, phase 3 owns `src/rag/jev.ts`, phase 4 owns the tool surface and session wiring, and
phase 5 owns the UI, the library store, and the verification fixtures. File ownership is
exclusive except for `src/session/session-provider.tsx`: phase 2 lands the
hydrate/abort/clear wiring there and phase 5 adds one library-store clear call to the same
cleanup. Phases run in order, so the later phase extends the file and never rewrites it.

## Dependencies

- Core infra (`260918-1209-core-infra-vault`) is implemented: vault crypto, settings
  store, `createLLM`, `createTypeSafe`, and the unlock/lock lifecycle are all in place.
- A configured provider with an embedding model, and a TypeSafe API key, are runtime
  prerequisites the user supplies; the feature degrades to "tools unavailable" without
  them.
- New package: `pdfjs-dist@6.3.289`, added with `--save-exact`, with its `exports` map
  checked before the dynamic import paths are written.
- New package: `gpt-tokenizer` for token-based chunking. It is a pure TypeScript BPE
  implementation (`cl100k_base`/`o200k_base`) with no wasm, so it runs on the main thread
  under the production CSP, which allows no `wasm-unsafe-eval` (`vite.config.ts:41`).

## Risks

| Risk | Likelihood x impact | Mitigation |
| --- | --- | --- |
| Jev judgment quality on the user's content, especially non-English | High x High | Calibrate on the user's own documents; author `instructions` and `criteria` in English; surface confidence; keep a Vietnamese fixture test in phase 3 and document the multilingual caveat in the tool guide |
| Jev call volume (k requests per retrieval, repeated per turn) | Medium x Medium | Pool of 4, answer cache keyed by hash, dedupe already-graded chunks, route-reads-cached-answers so threshold changes cost nothing, and count usage per session |
| Remote-embedding provider capability (no embedding model, wrong dims, no batching) | Medium x High | The user picks the embedding provider and model explicitly in the Documents panel, the embedder resolves exactly that pair, and a one-item `embedMany` probe runs before an ingest run and fails with a message naming the provider, the model, and the fix; dimensions are recorded per document |
| pdf.js worker under the production CSP | Low x High | Load pdf.js dynamically in a same-origin emitted worker, which does not inherit the document meta CSP; verify text extraction and the worker URL in the built app during phase 5 |
| pdf.js worker attack surface from attacker-controlled PDF bytes | Medium x High | Same-origin worker with page-equivalent network egress and IndexedDB access, and no document CSP; the vault key never enters the worker, so the exposure is availability and egress, not key material; residual risk accepted and recorded, with a hostile-PDF checklist case in phase 5 |
| Ingest crash leaves orphan chunks or a document without its chunks | Medium x Medium | One read-write transaction (or one queue task) writes the chunk rows and the document row together; an orphan-chunk sweep on hydrate/unlock deletes chunks whose `docId` has no `documents` row, and `listChunkIds` joins against `documents` |
| Stale vector index after an add or a delete | Medium x Medium | Ingest calls `addVectors` and delete calls `removeDocument`/`removeVectors` on the live index, and every read re-checks the generation stamp, so a stale entry can never be scored |
| A lock lands during an in-flight search | Medium x High | `requireIndex()`/generation is re-checked immediately before each decrypt, `VaultLockedError` maps to `ToolResultError('disabled', ...)` with a hint, and the tool's `AbortSignal` cancels the in-flight embed and Jev calls |
| A Jev cache outlives the lock that should drop it | Low x Medium | No module-level default cache: the cache is created per port, the port is per session and disposed with it, and the cache is generation-guarded like `src/ai/client-cache.ts` |
| Decrypt-on-unlock cost at the 1,000-document / 50,000-chunk target | Medium x Medium | Vectors are sized against `RAG_VECTOR_MEMORY_BUDGET_BYTES` at hydrate: resident when they fit, otherwise paged with a document-keyed cache bounded by the same budget; chunk text is decrypted lazily for the shortlist, and a progress state shows while hydrating |
| Paged retrieval re-decrypts documents and inflates a query's wall time | Medium x Medium | The same budget bounds the document cache, a batch is read and scored once per scan, and only the running top-k is retained; the phase 5 measurement records the paged mode's own median so the cost is visible rather than assumed |
| Prompt injection is not a security boundary | High x High | Injection is one Noul filter; the system prompt declares passages untrusted, and the bypass class is documented rather than claimed solved |
| Confidence misread as correctness | Medium x High | Thresholds live in one object, are never ported between question types, and the tool guide states that confidence describes the answer, not its truth |

## Success Criteria

- [x] Text, markdown, and PDF documents ingest, embed, encrypt, and persist across
      reload, with no plaintext content or vectors in IndexedDB. (Text/markdown exercised
      end to end; the PDF path is seam-tested and its real worker run is a browser item.)
- [x] A wrong password reveals nothing and stored vectors are unreadable at rest.
- [x] At the target scale of 1,000 documents / ~50,000 chunks, top-k local retrieval
      excludes network embedding and stays within the phase 5 measured budget: resident mode
      targets well under ~150 ms median, and a paged mode records its own measured median and
      the memory budget it respected. (Resident measured at 15.26 ms median in
      `reports/phase-02-target-scale-measurement.md`; the paged median is outstanding.)
- [x] A false-premise query routes to `conflicting_evidence`, and the model reports the
      conflict instead of fabricating.
- [x] A plain hidden instruction is filtered before reaching the LLM, with the bypass
      class documented.
- [x] A hallucinated or contradicted citation is flagged by `verify_citation`.
- [x] Passages entering the prompt drop measurably versus ungated retrieval.
- [x] The encrypted index persists and is readable offline; a new query embedding
      requires the provider.
- [x] Locking the vault clears keys and decrypted vectors from memory.

Browser-only verification (the hostile-PDF case, the two-tab schema upgrade, the real
pdf.js worker under the production CSP, and the paged target-scale median) is recorded as
outstanding in `reports/phase-05-manual-checklist.md`; it was not run because the session
had no browser.

## Red Team Review

### Session — 2026-09-22

**Findings:** 18 accepted (15 individual findings plus 3 rows that group minor findings),
0 rejected, 0 deferred.
**Severity breakdown:** 3 Critical, 10 High, 5 Medium.

| # | Finding | Severity | Disposition | Applied To |
| --- | --- | --- | --- | --- |
| 1 | A same-origin pdf.js worker parses attacker-controlled PDF bytes without a stated threat model | Critical | Accept — threat model recorded; defence is key isolation, residual risk accepted | plan.md, phase 1, phase 5 |
| 2 | The withheld injection payload is echoed into the tool result | Critical | Accept — return a reason code, the route decision, and counts only | phase 3, phase 5 |
| 3 | The Jev answer cache is a module-level singleton with no lock or dispose lifetime | Critical | Accept — cache threaded through `options.cache`, per-port instance, generation-guarded, `clearJevCache` redefined or removed | phase 3, phase 4 |
| 4 | `gradePairs` rejects the whole batch when one pair fails; no rate-limit throttle or wall-time bound | High | Accept — per-pair containment with failures reported, `retryAfterMs` throttle, caller-signal bound | phase 3 |
| 5 | Document and chunk rows are written non-atomically, so a crash leaves orphan chunks | High | Accept — one read-write transaction, orphan sweep, `listChunkIds` joins `documents` | plan.md, phase 1, phase 2 |
| 6 | The vector cache is not updated or evicted on ingest and delete | High | Accept — `addVectors` on ingest, `removeDocument`/`removeVectors` on delete, wired in the panel store | plan.md, phase 2, phase 5 |
| 7 | A lock during a search surfaces as `runtime_error` and a stale index could still serve vectors | High | Accept — generation re-check before each decrypt, `VaultLockedError` mapped to `disabled` with a hint | plan.md, phase 2, phase 4 |
| 8 | The `AbortSignal` is never threaded from the tool execution options into embedding and Jev calls | High | Accept — `execute(input, { abortSignal })` end to end, with an abort test | plan.md, phase 4 |
| 9 | `get_chunk` is reachable with any chunk id and the "only entry point" claim is false | High | Accept — a session capability set restricts reads to ids a prior result returned, with a refusal test | phase 4 |
| 10 | The ingest write task never re-checks keyring identity, so a mid-ingest lock can land rows | High | Accept — re-assert before the Dexie ops, mirroring `useVaultStore.update` | phase 1 |
| 11 | `hydrate` can clear a newer valid cache or leave a partial map on abort or error | High | Accept — clear only this call's partial map, generation-stamped clear, `dims` as the dimension source | phase 2 |
| 12 | `SessionProvider` cleanup races an in-flight hydrate, and StrictMode double-mounts it | High | Accept — `AbortController` aborted before `clear()`, race documented | phase 2 |
| 13 | `useDocumentLibraryStore` has no `clear()`, so decrypted titles survive a lock | High | Accept — `clear()` wired into the session cleanup, with coverage | phase 5 |
| 14 | `resolveThresholds` clamps only `concurrency` | Medium | Accept — every known threshold clamped to `[0, 1]`, with an out-of-range test | plan.md, phase 3 |
| 15 | The false-premise early exit is claimed through a placeholder conversation rather than real premise grading | Medium | Accept — `routeQuery({ query, context? })`, the tool-path exit marked inert, `contradicts_premise` named as the primary path | plan.md, phase 3, phase 4 |
| 16 | (grouped) Type-contract drift: `embed`/`embedMany` return shapes, a dimension on `EmbeddingModelUsage`, and `cosineSimilarity` failing with `InvalidArgumentError` | Medium | Accept — `tokens`-only usage stated, `dims` on `ChunkRecord`, mismatch rethrown as `RagIndexError` | plan.md, phase 1, phase 2 |
| 17 | (grouped) Unbounded extracted text, an enforced cap missing, and a synchronous chunk+encrypt loop that can pin the main thread | Medium | Accept — `MAX_EXTRACTED_CHARS` and `MAX_FILE_BYTES` enforced in extraction before chunking, plus a macrotask yield boundary | phase 1 |
| 18 | (grouped) Schema and lifecycle plumbing gaps: Dexie `blocked`/`versionchange`, the `settings.test.ts` concurrency default assertion, the fixture's `concurrency: 2`, and missing lifecycle test coverage | Medium | Accept — handlers and the two-tab notice in phase 1, fixtures and tests updated, lifecycle module and test assigned | phase 1, phase 2, phase 4, phase 5 |

### Whole-Plan Consistency Sweep

- Files reread: plan.md, `phase-01-document-store-and-ingest.md`,
  `phase-02-local-retrieval.md`, `phase-03-jev-judgment-module.md`,
  `phase-04-rag-tools-and-session-wiring.md`,
  `phase-05-library-panel-and-end-to-end-verification.md`.
- Reconciled stale references: the placeholder-context claim, the pdf.js pin and import
  path, the module-level Jev cache, the "payload visible in the tool result" statement,
  the dimension-from-usage claim, and `embedQuery` still returning `embeddings[0]` in
  phase 2 after the `embed`/`embedMany` correction (fixed to `result.embedding`).
- Unresolved contradictions: 0.

## Validation Log

### Session 1 — 2026-09-22

**Questions asked and decisions confirmed.**

| ID | Question | Decision |
| --- | --- | --- |
| D1 | How is chunk size defined, given there is no tokenizer in the bundle? | Token-based chunking with `gpt-tokenizer` (pure TypeScript BPE, no wasm, main-thread safe under the CSP): constants become `MIN_CHUNK_TOKENS`/`MAX_CHUNK_TOKENS` clamped to `[64, 1024]`, and `rag.chunkSize`/`rag.overlap` become token counts with defaults 400 and 60 (~15%). `topK` stays 5. The clamp is justified against the embedding model's ~8k-token input limit and Jev's 32k-token state-plus-longest-question budget. |
| D2 | Does the embedding provider get picked silently? | No: the Documents panel exposes an embedding provider selector and an embedding model input, defaulting to the first configured provider and `settings.rag.embedModel` and persisting the pick to `rag.embedProviderId`/`rag.embedModel`. The fallback resolution only seeds that control. Phase 1 keeps the one-item probe before the first ingest, and it fails with a clear, actionable error naming the provider when the endpoint serves no embedding model. |
| D3 | Is citation verification an exact-match test only? | No: `verifyCitation` runs the deterministic exact normalized substring check first, then a token-overlap fuzzy prefilter when it misses. Only a score below the documented `citationFuzzyMin` floor is `fabricated` with no Jev call; at or above the floor the claim proceeds to the Jev Choice. The floor is a `THRESHOLDS` entry clamped to `[0, 1]` like the others, and it is tunable per call. |
| D4 | What scale must retrieval hold, and how? | 1,000 documents / ~50,000 chunks, met with a lazy/bounded vector index and no ANN: `RAG_VECTOR_MEMORY_BUDGET_BYTES` (default 128 MiB) decides resident mode (one contiguous `Float32Array` plus a chunk-id → offset map) or paged mode (per-document bounded batches with an LRU document cache under the same budget). `cosineTopK` stays exact in both modes and reports the mode. An ANN or approximate index remains a Non-Goal. |
| D5 | Jev model, and the `get_chunk` read surface | Keep honoring `settings.typesafe.model` (`jev-latest`) and log the response's `result.model`; no phase pins a versioned id. `get_chunk` stays restricted to the session capability set of chunk ids that a prior `search_documents` or `verify_citation` result returned in the same session. |

**Effort.** Phase 2 gains a second retrieval mode, a document cache bounded by the same
budget, a batched exact scan, and a target-scale timing fixture; that is at least two hours
on top of the original 5h estimate, so phase 2 moves to 7h and the plan total to 36h. The
other phases absorbed their changes inside their existing estimates.

### Whole-Plan Consistency Sweep

- Files reread in full: `plan.md`, `phase-01-document-store-and-ingest.md`,
  `phase-02-local-retrieval.md`, `phase-03-jev-judgment-module.md`,
  `phase-04-rag-tools-and-session-wiring.md`,
  `phase-05-library-panel-and-end-to-end-verification.md`; plus the source seams the edits
  cite — `src/vault/settings.ts:43-48,132-137`, `src/vault/settings.test.ts:95,133`,
  `src/vault/test-fixtures.ts:52-57`, `src/ai/typesafe.ts:16-20`, `vite.config.ts:33-51`,
  and `package.json:16-48` (dependency list format).
- Decision deltas checked: D1 (token constants and defaults, every chunk-size "characters"
  mention, Dependencies, phase 1 install step and `package.json`); D2 (plan constraints,
  phase 1 requirement/step, phase 5 panel requirement/step/architecture); D3 (`THRESHOLDS`,
  the `resolveThresholds` clamp list, requirements, architecture, steps, success criteria,
  and the "brittle by design" comment); D4 (acceptance criterion 3, success criteria,
  architecture blocks, phase 2 requirements/insights/steps/todo/criteria/risks, phase 5
  checklist step 11 and criteria); D5 (model statements in phases 3 and 4, capability-set
  consistency between phases 4 and 5).
- Stale references reconciled: `chunkSize chars` in the ingest architecture; the
  "in-memory Float32 cache" claim, now that paged mode exists; the 2,000-chunk timing test
  and "hundreds of documents, a few thousand chunks" phrases; the "per-document lazy vector
  loading" follow-up that paged mode now delivers; the exact-match-only `fabricated`
  description; and the fixture/`defaultSettings()` chunk defaults.
- Acceptance criterion 6 was checked for an exact-match implication and has none, so it is
  unchanged: the fuzzy prefilter sits behind the same `verify_citation` verdict names.
- Backwards compatibility: no shipped build chunks documents under the character semantics —
  `src/rag/chunker.ts` does not exist yet, and nothing outside `src/vault/settings.ts` reads
  `rag.chunkSize`/`rag.overlap` — so there are no stored chunk rows to migrate. A persisted
  `rag.chunkSize` written under the old character default is clamped into `[64, 1024]` tokens
  on read, so an existing vault degrades to a larger-than-default chunk rather than failing.
- Unresolved contradictions: 0.
