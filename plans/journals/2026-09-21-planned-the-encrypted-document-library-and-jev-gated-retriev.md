---
title: Planned the encrypted document library and Jev-gated retrieval pipeline
date: 2026-09-21
summary: "Re-authored the stale RAG plan into a 5-phase, red-teamed contract: token chunks, remote embeddings, resident/paged cosine index, and four read-only Jev tools."
---

# Planned the encrypted document library and Jev-gated retrieval pipeline

## What happened

The plan in `plans/260918-1210-rag-typesafe-pipeline/` was a stale, still-blocked draft from 2026-09-18 that predated the harness. It assumed local `@huggingface/transformers` embeddings, treated PDF as a non-goal, and pointed at "three TypeSafe checkpoints." The blocker (core-infra vault) had long been implemented, and `createTypeSafe`, `settings.rag`, and `settings.typesafe` (`jev-latest`) already existed and were tested.

Re-authored it into a 5-phase plan against the actual code:

1. Document store and ingest — Dexie `version(6)` for `documents`/`chunks`, binary vector records via `encryptRecordBytes`, `gpt-tokenizer` chunking (400/60 tokens), pdf.js in a same-origin worker, a `createEmbedder` factory over `@ai-sdk/openai-compatible`, and an atomic ingest.
2. Local retrieval — a resident-or-paged `Float32Array` index under a 128 MiB budget, exact cosine scan via `ai`'s `cosineSimilarity`, and an `unlockGeneration` guard.
3. Jev judgment module — `routeQuery`, `selectQuery`, `gradePair` (5 questions per pair), `gradePairs` (pool of 4, SHA-1 cache), `verifyCitation`, all thresholds in one clamped object.
4. RAG tools and session wiring — `list_documents`, `search_documents`, `get_chunk`, `verify_citation` as a `ToolProvider`, threaded through all five port sites and `READ_ONLY_TOOLS`.
5. Library panel and end-to-end verification — Documents rail panel, citation renderer, adversarial fixtures, hostile-PDF and two-tab checklist cases, and a 50k-chunk timing measurement.

Two research reports (TypeSafe API, harness integration) and a 3-lens red-team review (security adversary, failure mode analyst, assumption destroyer) ran against the codebase.

## Decisions

- Embeddings are remote through the user's configured provider; the index, storage, and scan stay local. "Fully client-side" therefore excludes new-query embedding, and acceptance criterion 8 was rewritten to say so rather than claim offline retrieval.
- The corpus is a separate, user-managed library; the agent is read-only over it.
- Jev is judgment-only. It never generates text, so "query reformulation" is a Choice over code-generated candidates, not a rewrite.
- Token chunking via `gpt-tokenizer` (400/60 tokens, clamp 64-1024), replacing the old character-based draft.
- Scale target is 1,000 documents / ~50,000 chunks, met with a resident/paged vector cache and a measured budget instead of single-digit ms; ANN stays a non-goal.
- Citation verification adds a token-overlap fuzzy prefilter (`citationFuzzyMin`, default 0.35) before the Jev Choice.
- The Jev model stays `settings.typesafe.model` (`jev-latest`); `result.model` is logged so threshold drift is visible.

## Red-team outcome

18 findings accepted, 0 rejected: 3 Critical, 10 High, 5 Medium. The two hard errors were `embed()` returning `embedding` (not `embeddings[0]`), which would have made `embedQuery` return `undefined`, and a pdf.js worker with no stated threat model. The design-level Highs were ingest atomicity (orphan chunks), vector-cache invalidation on add/delete, `get_chunk` bypassing the injection filter, lock-during-search error mapping, unbounded hydrate races, and a duplicate/orphaned Jev cache. All were applied; the whole-plan consistency sweep closed with 0 unresolved contradictions.

## Next steps

- `/ak:cook plans/260918-1210-rag-typesafe-pipeline/plan.md` (phases run in order).
- The plan's `branch` frontmatter still reads the current `feat/token-metering-and-compaction`; create a dedicated branch or worktree before cooking.
- Remaining follow-ups belong to a later plan: non-English threshold calibration on real documents, an ANN index only if the scale target grows, and a `plans/README.md` status entry after implementation.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
