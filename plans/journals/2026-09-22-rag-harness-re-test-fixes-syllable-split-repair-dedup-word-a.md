---
title: "RAG harness re-test fixes: syllable-split repair, dedup, word-aware chunking"
date: 2026-09-22
summary: "Closed the retest residuals: Vietnamese syllable-split repair (F5), boundary-overlap dedup (F8), and whole-word chunk windows (F4)."
---

# RAG harness re-test fixes: syllable-split repair, dedup, word-aware chunking

## What happened

Worked `reports/rag-harness-retest.md`. F1/F2/F3/F6/F9/F10/F11/F12/F14 were re-verified fixed;
three residuals remained and are now closed.

1. **F5 syllable-split repair** — NFC composes the diacritic but not the space the extractor injected
   (`quyề n`). Added `src/rag/text-normalize.ts::normalizeVietnameseSyllableSplits`, applied in
   `pdf.ts normalizeWhitespace` (new ingests) and `jev.ts normalizeForMatch`/`contentTokens`
   (matching stored text). A clean quotation now matches a corrupted passage deterministically
   (`score: 1`, `span` returned). The rule accepts only a coda or single-vowel fragment: a
   vowel-plus-coda fragment is rejected because `em`/`ăn`/`ông` are real words, so `và em` is not
   merged. Cost: `nư ớc` (vowel-plus-coda split) stays unrepaired.
2. **F8 dedup** — mutual 0.9 containment cannot catch sliding-window overlap. Added a second rule:
   same document + adjacent ordinal + smaller passage >= 0.6 contained in the larger.
3. **F4 chunk boundaries** — fallback windows now pack whole words (`packByWords`) instead of raw
   token slices, so a chunk never opens or closes mid-word and the overlap prefix cannot stitch a
   fragment.

## Decision

- The retest F4/F5/F8 observations are on pre-fix stored chunks and vectors; extraction and chunking
  fixes are not retroactive. Re-ingesting the four documents is the operator step that validates
  F5/F7 and refreshes the vectors; the harness cannot do it itself.
- Kept the extraction-side repair (not only match-time) because a coda/single-vowel fragment is
  never a standalone word, making the join safe; rejected the broader vowel+coda variant for that
  reason.

## Verification

`npx vitest run` 1336 passed / 1 skipped; `npx tsc -b` clean; `npx eslint` clean; `npx vite build` OK.
New tests: text-normalize unit cases, extractor repair, clean-claim-vs-split-passage deterministic
match, whole-word chunk boundaries, near-duplicate collapse.

## Next steps

- Delete and re-ingest the library so stored text and vectors match the new pipeline.
- Pin down the Jev prompt distinction between "source says nothing" and "source contradicts this"
  (retest section 5 semantic note).
- Optionally extend the repair to vowel-plus-coda splits with a syllable lexicon.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
