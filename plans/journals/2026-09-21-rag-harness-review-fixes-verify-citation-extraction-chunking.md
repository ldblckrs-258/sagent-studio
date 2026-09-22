---
title: "RAG harness review fixes (verify_citation, extraction, chunking, retrieval)"
date: 2026-09-21
summary: Fixed all 15 findings from reports/rag-harness-review.md across jev/pdf/chunker/port + added a get_neighbors tool and a regression wall.
---

# RAG harness review fixes (verify_citation, extraction, chunking, retrieval)

## What happened

Worked `reports/rag-harness-review.md` to completion (P0/P1/P2 + §11 fixtures).

Root causes confirmed in code:
- F1 `normalizeForMatch` folded `“”`→`"` but kept the char, so quoted claims could never exact-match.
- F2 `tokenOverlapScore` was symmetric Jaccard against the whole passage; the union denominator
  made a faithful short quote score ~0.01 < floor 0.35, so the Jev path was structurally unreachable.
- F3 below-floor returned `fabricated, auto:true` — a true quote and a hallucination were byte-identical.
- F4 chunker knew only markdown `#` and blank lines; PDF pages arrive blank-line-free, so articles fused.
- F5/F6 no NFC; `\p{M}` excluded from the tokenizer; stopwords were unaccented and inert.
- F7/F8/F9/F10/F11/F12/F14 as reported.

Changes:
- `src/rag/jev.ts` — NFC + quote-stripping normalizer; containment (`intersection/claimTokens`) instead
  of Jaccard; below-floor → `unsupported`/`auto:false`; `fabricated` now requires an explicit Jev
  negative (new `is_fabricated` Noul), never inferred from a lexical floor; `auto` only for
  verified/contradicted at high confidence; returns `score` + `span`; accented Vietnamese stopwords;
  `filterInjectedPassages` for ungraded reads.
- `src/rag/pdf.ts` — NFC; mark-aware gap threshold (2× at a combining-mark boundary); repeated
  header/footer stripping; narrower glued page-number regex (excludes `.`/`:` so `Thời hạn: 36` survives).
- `src/rag/chunker.ts` — recognizes `Điều`/`Chương`/`Phần`/`Mục` headings line-by-line; sentence/clause
  boundaries before token windows; restores whitespace between packed units (tokenizers fold the
  separator into the next token, so raw token-array concatenation fused sentences).
- `src/rag/port.ts` — near-duplicate dedup (mutual containment), `reason` + `candidatesScanned`,
  `dims`/`createdAt` in the summary, inject-filtered `getNeighbors`.
- `src/tools/builtin/rag.ts` + approval/tool-guide/rag.md/context prompt/UI card — new `get_neighbors`
  tool, corrected descriptions, reason-aware empty state.

## Decision

- `fabricated` is reserved for an explicit Jev negative; a claim with little or no lexical overlap is
  `unsupported`. Keeps all four verdicts reachable without the harness accusing a true quote.
- `getNeighbors` runs the injection Noul over neighbours (fail-closed) so the post-F14 expansion cannot
  surface withheld text.
- Kept the report's quote *stripping* despite the lossy edge case; it is the only reliable way a
  naturally-quoted claim matches the unquoted passage.

## Verification

`npx vitest run` 1330 passed / 1 skipped; `npx tsc -b` clean; `npx eslint` clean; `npx vite build` OK.
Added regression fixtures for the §11 matrix (quoted claim, short quote vs long passage, NFD text,
line-break quote, different-passage claim, skipped/premise_conflict reason, multi-chunk neighbours).

## Next steps

- Corpus-side: re-ingest the NFD/article PDFs to benefit from extraction fixes; the harness cannot
  repair already-stored chunk text.
- Measure recall against a document with a known-complete answer (report §12 left this open).
- Optional: surface document `status: draft|final` (product decision, no source of truth yet).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
