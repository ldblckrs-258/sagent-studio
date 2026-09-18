---
title: "RAG + TypeSafe Pipeline"
description: "Client-side ingestion and retrieval with three TypeSafe enhancement checkpoints driving an agent loop"
status: pending
priority: P1
effort: 28h
branch: none
tags: [feature, frontend, ai, rag]
blockedBy: [project:260918-1209-core-infra-vault]
blocks: []
created: 2026-09-18
---

# RAG + TypeSafe Pipeline

## Overview

This plan adds client-side document ingestion and retrieval, then layers three
TypeSafe judgment checkpoints over it and drives the result from an agent loop. The
user adds text or markdown files, which are chunked and embedded on-device into the
encrypted index built on Plan 1's vault. A question is answered by an LLM API whose
`search` tool retrieves locally, gates and re-ranks with TypeSafe, and whose
`verify_citation` tool checks the answer against source chunks.

**This plan is blocked.** Phase files are authored after the core-infra plan lands,
because the vault, settings store, and factory interfaces this plan consumes are
fixed there. The scope, phase breakdown, and risks below are recorded now so the
dependency is visible.

Source of truth for the contract and approach comparison:
[`reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md`](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md).

## Dependencies

| Relationship | Plan | Status |
| --- | --- | --- |
| Blocked by | `project:260918-1209-core-infra-vault` | pending |

Consumed interfaces from Plan 1:

- `createLLM(settings, providerId) -> LanguageModel`
- `createTypeSafe(settings) -> TypeSafeClient`
- The decrypted settings snapshot with `rag` and `typesafe` fields
- The vault unlock/lock lifecycle and idle auto-lock

## Phases (planned)

| # | Phase | Status |
| --- | --- | --- |
| 1 | Ingest: Chunk + Embed | Pending |
| 2 | Search: Decrypt-on-Unlock + Cosine Scan | Pending |
| 3 | TypeSafe Module: Questions, Thresholds, Routing | Pending |
| 4 | Checkpoints: Intent, Gate/Re-rank, Citation | Pending |
| 5 | Agent Loop: Tools + Streaming UI | Pending |

Phase files are created with `ak plan add-phase` once Plan 1 completes and the
interfaces above are stable.

## Planned Scope

- Embeddings via `@huggingface/transformers` (`multilingual-e5-small` q8, 384 dims),
  WebGPU when available with a WASM fallback.
- E5-family `query:` / `passage:` prefix convention applied consistently.
- Chunk text and vectors encrypted at rest; document metadata plaintext so the
  library list renders before unlock.
- Decrypt-all-on-unlock, because cosine scanning needs real numeric vectors; measure
  unlock cost at target scale.
- One TypeSafe request per query-passage pair carrying five independent questions
  (re-rank score, relevance, evidence, premise contradiction, injection) rather than
  two sequential calls.
- All thresholds in a single `THRESHOLDS` object; routing reads stored answers only,
  so threshold changes cost no API calls.
- TypeSafe calls capped by a promise pool of about four and cached by
  `sha1(query + passageId)`; already-graded chunks are not re-graded.
- `search` returns chunk `id` and `docTitle` so citations resolve to Dexie records.
- The generator prompt treats every passage as untrusted text regardless of score.

## Non-Goals

- ANN / approximate nearest neighbour index.
- PDF or DOCX parsing (text and markdown only).
- TypeSafe as a text generator.
- Server-side retrieval or embedding.

## Risks

| Risk | Mitigation |
| --- | --- |
| Jev judgment quality on Vietnamese (docs make no multilingual guarantee) | Spike in Phase 3 with a labeled Vietnamese sample; author `instructions`/`criteria` in English if weak. `gradePair()` and `route()` isolate the change. |
| 36-60 TypeSafe calls per query at k=12 | Promise pool cap, per-pair cache, de-duplicated grading, measured k tuning |
| Decrypt-all-on-unlock cost | Store vectors as `Float32Array`; measure at a few thousand chunks in Phase 2; move to lazy per-document load if needed |
| Embedding model download size and first-run latency | Show progress, cache the model, document offline-after-first-load behavior |
| Prompt injection is not a security boundary | The injection score is a filter only; the prompt instruction is the actual defense |

## Success Criteria

- [ ] Files ingest and persist encrypted across reload; no plaintext content in IndexedDB.
- [ ] Top-k retrieval returns locally, offline, in single-digit milliseconds at target scale.
- [ ] A false-premise query routes to `conflicting_evidence` and the LLM reports the conflict.
- [ ] A plain (non-obfuscated) hidden instruction is filtered before reaching the LLM; a
      documented adversarial fixture set records the filter's bypass class. This is a
      best-effort filter, not a security boundary.
- [ ] A hallucinated or contradicted citation is flagged by `verify_citation`.
- [ ] The number of passages entering the prompt drops measurably versus ungated retrieval.
- [ ] The agent loop respects a step cap and streams an answer with source ids.
