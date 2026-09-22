# RAG Harness Review — code-verified findings

**Method.** Black-box probing through the live `list_documents` / `search_documents` / `get_chunk` /
`verify_citation` tools, then reading the implementation to confirm or reject each runtime symptom.

**Code read:** `src/rag/jev.ts`, `src/rag/port.ts`, `src/rag/chunker.ts`, `src/rag/pdf.ts`,
`src/rag/ingest.ts`, `src/rag/store.ts`, `src/rag/types.ts`, `src/rag/index-cache.ts`,
`src/rag/jev.test.ts`, `src/tools/builtin/rag.ts`.

**Corpus under test:** 2 documents — one Vietnamese **draft** statute (8 chunks, NFD-clean) and one
NFD/page-space-corrupted article (3 chunks).

> Correction to my previous turn. Two of my earlier claims were wrong and are retracted:
> 1. I blamed the failed exact match on a newline inside a word (`Bộ\ntrưởng`). **Wrong** —
>    `normalizeForMatch` collapses `\s+`, so that case normalizes fine. The real trigger is
>    quotation marks (see F1).
> 2. I said the verdict space collapses because no Jev fallback exists. **Wrong** — a Jev fallback
>    exists but is *unreachable* for real corpus passages (F2).

---

## 0. Findings at a glance

| # | Finding | Runtime symptom | Code locus | Classification |
|---|---|---|---|---|
| F1 | `normalizeForMatch` folds quote characters but never strips them | True quote returns `fabricated` | `jev.ts` `normalizeForMatch` (l.680) | **Bug** |
| F2 | Fuzzy floor uses symmetric Jaccard against the **whole passage** | Fallback (Jev) unreachable ⇒ binary exact-match-or-`fabricated` | `jev.ts` `tokenOverlapScore` (l.689), `citationFuzzyMin: 0.35` (l.100), l.735 | **Bug (design)** |
| F3 | `fabricated` is the label for "low lexical overlap" and is `auto: true` | Invented claim and true quote are indistinguishable | `jev.ts` l.735–737 | **Bug (semantics)** |
| F4 | Chunker only understands markdown headings + blank lines | Chunks cut mid-sentence; several unrelated `Điều` per chunk; no article header | `chunker.ts` `isHeading`, `splitBlocks`, `toUnits` | **Bug** |
| F5 | PDF extractor inserts spaces on a geometric gap heuristic; no NFC anywhere | `quyề n`, `cộ ng`, `nghĩ a`, `đã`, `mộ t` | `pdf.ts` `joinTextItems` / `normalizeWhitespace` | **Bug** |
| F6 | Tokenizer excludes `\p{M}`; stopword list is unaccented | NFD Vietnamese shredded at token level; stopwords never match | `jev.ts` `contentTokens` (l.313), `STOPWORDS` (l.307) | **Bug** |
| F7 | No header/footer/page-furniture stripping | `DỰ THẢO / TRÌNH QUỐC HỘI THÔNG QUA … 2` mid-chunk; `…36 tháng.”;7` | `pdf.ts` `extractText` | **Bug** |
| F8 | Overlapping chunks returned with no dedup/MMR | ~50% of top-K is near-duplicate | `chunker.ts` (overlap by design) + `port.ts` `search` (no dedup) | **Missing feature** |
| F9 | Route-level `conflicting_evidence` and `skip` both return a fully empty payload | Premise-conflict is reported to the model as "nothing relevant" | `port.ts` `search` / `emptyResult` | **Bug** |
| F10 | Route-level premise branch is dead on the tool path | Can't fire at all | `port.ts` `search` calls `routeQuery(client, { query })` | By design, but silently so |
| F11 | `list_documents` description promises "embedding dimensions" the payload never contains | Model-facing description is false | `tools/builtin/rag.ts` l.53 vs `port.ts` `RagDocumentSummary` | **Doc/contract bug** |
| F12 | `topK` is a pre-rerank candidate count, undocumented | 8→6, 5→2 with no explanation | `tools/builtin/rag.ts` `readTopK`, `port.ts` `search`, `index-cache.ts` `cosineTopK` | **Missing doc** |
| F13 | `cosineTopK` applies no similarity floor | Only relevance gate is the Jev model | `index-cache.ts` `cosineTopK` (l.319–355) | By design |
| F14 | `verify_citation` / `get_chunk` are limited to ids the reranker already included | Verification surface == display surface | `port.ts` `noteCapability` | By design, with a real cost |
| F15 | Test suite only exercises ~7-word passages | Every bug above is invisible to CI | `jev.test.ts` `describe('verifyCitation')` (l.304–370) | **Test gap** |

---

## 1. Reproduction matrix (`verify_citation`)

All runs against chunk `ff103953…` (draft statute) unless noted.

| Claim | Passage contains it? | Verdict | Should be | Code path taken |
|---|---|---|---|---|
| `“Điều 32. Thẩm quyền, trách nhiệm của Bộ trưởng Bộ Ngoại giao”` | yes, **with** curly quotes | `verified` | verified | exact substring hit (l.733) |
| `“Bộ trưởng Bộ Ngoại giao trình Thủ tướng Chính phủ phê duyệt đề án.”` | yes, **without** quotes | `fabricated` | verified | F1 ⇒ miss ⇒ F2 ⇒ floor (l.735) |
| Paraphrase of a real provision | semantically yes | `fabricated` | verified/paraphrase | F2 |
| `Bộ trưởng … có quyền tuyên chiến và điều động quân đội` (invented) | no | `fabricated` | fabricated | F2 |
| `…36 tháng` against chunk `b58e7478…` (not in that chunk) | no (in a different chunk) | `fabricated` | `unsupported` | F2 + F3 |

Rows 2 and 4 produce **byte-identical verdicts**. The tool cannot distinguish a verbatim quotation
from a hallucination, and it auto-accepts both.

---

## 2. F1 — quote characters are folded, not stripped

```ts
// src/rag/jev.ts
export function normalizeForMatch(value: string): string {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
```

Folding `“ ”` to `"` normalizes the *form* but keeps the character, so any claim written the way a
model naturally quotes — `“text”` — can only exact-match a passage that also contains the quotes.
`readString` in `tools/builtin/rag.ts` only `.trim()`s the claim, so nothing removes them upstream.

**Effect:** the fast path (the only reliable path, per F2) fails for the single most common input
shape: a quoted quotation.

**Fix**

```ts
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\p{Pi}\p{Pf}"'«»„“”‘’]/gu, '')   // strip quote marks entirely
    .replace(/\s+/g, ' ')
    .trim()
}
```

---

## 3. F2 — the fuzzy floor is a symmetric Jaccard against the entire passage

```ts
// src/rag/jev.ts:689
export function tokenOverlapScore(claim: string, passage: string): number {
  const claimTokens = new Set(contentTokens(claim))
  const passageTokens = new Set(contentTokens(passage))
  if (claimTokens.size === 0 || passageTokens.size === 0) return 0
  let intersection = 0
  for (const token of claimTokens) if (passageTokens.has(token)) intersection += 1
  const union = claimTokens.size + passageTokens.size - intersection
  return union === 0 ? 0 : intersection / union
}
```

```ts
// src/rag/jev.ts:735
if (tokenOverlapScore(claim, passageText) < thresholds.citationFuzzyMin) {
  return { verdict: 'fabricated', confidence: null, auto: true, model: null }
}
```

`citationFuzzyMin` is `0.35` (l.100). Jaccard's denominator is the **union**, and the passage's token
set dominates it. A faithful 9-content-token quotation against a 1024-token chunk scores roughly
`8 / (600 + 9 − 8) ≈ 0.013` — two orders of magnitude below the floor. So:

> The Jev Choice is structurally unreachable for any quotation drawn from a real chunk. The "two-stage
> prefilter" degenerates into *exact normalized substring, else `fabricated`*.

The threshold comment ("calibrated against the fixture set") is the tell: the fixture set is
`'The cat sat on the warm mat.'` (7 tokens), where Jaccard behaves completely differently from a real
passage. The metric was calibrated on a regime the product does not operate in.

**Fix** — make the score asymmetric (containment, i.e. recall of the claim) and/or window the passage:

```ts
export function tokenOverlapScore(claim: string, passage: string): number {
  const claimTokens = new Set(contentTokens(claim))
  if (claimTokens.size === 0) return 0
  const passageTokens = new Set(contentTokens(passage))
  let intersection = 0
  for (const token of claimTokens) if (passageTokens.has(token)) intersection += 1
  return intersection / claimTokens.size          // containment, not Jaccard
}
```

Containment is length-invariant, which is exactly what a "does this claim have support here" gate
needs. If a stricter metric is wanted, score against the best-matching sentence window rather than the
whole passage.

---

## 4. F3 — `fabricated` is doing two jobs, and is auto-accepted

```ts
export type CitationVerdict = 'verified' | 'contradicted' | 'unsupported' | 'fabricated'
```

Four verdicts are declared; in practice only two are reachable (`verified` via exact match, else
`fabricated`), because the only route to `contradicted`/`unsupported` is a Jev call that F2 blocks.

`fabricated` here means "shares almost no content tokens with this passage", but it reads as "the
source does not contain this and the claim was invented", and it is returned with
`confidence: null, auto: true`. `tools/builtin/rag.ts` advertises `auto` as "whether the verdict was
auto-accepted" — so the harness actively signals *high trust* on its least reliable output.

This matters because the system prompt instructs the model to verify before asserting a quotation. A
compliant model is therefore pushed to either (a) withhold correct quotations, or (b) label a real
source as fabricated.

**Fix**
- Below-floor and no Jev verdict ⇒ `unsupported`, `auto: false`.
- Reserve `fabricated` for an explicit negative from Jev (`contradicts` with high confidence).
- Return the matched span for the exact path, and the fuzzy score, so a verdict is auditable.

---

## 5. F4 — the chunker has no concept of a legal document

```ts
function isHeading(block: string): boolean {
  return /^#{1,6}\s/.test(block.trim())
}
```

`splitBlocks` splits on blank lines only, and `toUnits` slices oversized blocks into fixed
`chunkSize`-token windows. `pdf.ts` joins pages with `'\n\n'`, so in a PDF the only reliable block
boundary is the page break. Consequences, all observed live:

- chunks open mid-sentence (leading space + mid-clause): `" quyết sách có ý nghĩa chiến lược…"`;
- fixed token windows cut mid-word, so the overlap prefix can stitch a *word fragment* onto the next
  chunk;
- a chunk mixes several unrelated `Điều` (Article) units and carries no article header — the passages
  I received mention `khoản 2a` / `Điều 21` with no way to tell which article the chunk belongs to;
- questions whose answer spans pages cannot be satisfied, because article text is scattered across
  page-sized chunks.

**Fix**
- Treat `Điều \d+\.`, `Chương [IVX]+`, `Phần`, `Mục` as headings for non-markdown sources.
- Prefix every chunk with provenance: `title · Điều N · trang P`.
- Prefer sentence/clause boundaries over raw token windows (split on `;\n`, `. \n`, `\n(?=\d+\.)`)
  before falling back to fixed windows.

---

## 6. F5 / F6 / F7 — the extraction and tokenization pipeline mangles Vietnamese

### F5 — a space is invented inside words

```ts
const SPACE_GAP_RATIO = 0.3
// ... if (gap > spaceWidth) text += ' '
```

The doc comment already names the failure mode: *"a PDF that places glyphs or syllables individually
produces items with tiny gaps; joining those with a space (or not) is what keeps words intact or
splits them apart."* The heuristic picks "or not" incorrectly for this corpus, yielding
`quyề n`, `cộ ng`, `nghĩ a`, `đã`, `mộ t`. No pass repairs it afterwards.

### F6 — the tokenizer then deletes the combining marks

```ts
.replace(/[^\p{L}\p{N}\s]/gu, ' ')   // \p{M} is NOT in the allow-list
```

Unicode general category **M** (combining mark) is not `L` or `N`, so every detached diacritic becomes
a space. `quyề n` → tokens `quyê` + `n`. For NFD Vietnamese this destroys the token stream, which in
turn zeroes the Jaccard score and guarantees `fabricated` (F2) for the entire second document.

Also:

```ts
const STOPWORDS = new Set([... 'la', 'va', 'cua', 'cho', 'mot', 'cac', 'nhung'])
```

These are unaccented, so they never match real Vietnamese text (`là`, `và`, `của`, `cho`, `một`,
`các`, `những`). Vietnamese stopword stripping is inert on the actual corpus.

### F7 — page furniture survives into the body

No header/footer/page-number removal. Observed mid-chunk:
`…doanh nghiệp Việt Nam.\nDỰ THẢO\nTRÌNH QUỐC HỘI THÔNG QUA\n(cập nhật thay thế dự thảo\ngửi ngày 19/4/2026)2\n3. Kiến nghị…`
and number-glued text: `…quá 36 tháng.”;7\nc) Bổ sung…`. This pollutes embeddings, corrupts quotes, and
guarantees exact-match failure wherever it lands.

**Fix (all three)**
- `value.normalize('NFC')` in `normalizeForMatch`, in `extractText`, and in `contentTokens`.
- Never emit a space when the previous item's last char or the next item's first char is `\p{M}`.
- Keep `\p{M}` in the tokenizer allow-list: `/[^\p{L}\p{M}\p{N}\s]/gu`.
- Add accented Vietnamese stopwords (or drop the list and rely on IDF).
- Detect lines that repeat across ≥ N pages and strip them, plus trailing page-number digits.

---

## 7. F8 — overlap duplication is produced by design and never collapsed

`chunkText` deliberately prefixes each chunk with the previous chunk's trailing `overlap` tokens, and
`port.ts` `search` pushes every non-excluded grade with no dedup:

```ts
for (const grade of sortByRerank(grades)) {
  if (grade.decision === 'exclude') { … continue }
  …
  if (grade.decision === 'conflicting_evidence') conflicting.push(passage)
  else included.push(passage)
}
```

Observed: chunk `ordinal 2` and `ordinal 3` are nearly identical; `ordinal 5`/`6` overlap heavily; in
the second document `ordinal 1` begins exactly where `ordinal 0` ends. Roughly half of every top-K is
redundant, burning context that the answer needs.

**Fix:** dedup by id and by near-duplicate text before returning; or apply MMR; or merge adjacent
ordinals into one passage with an explicit range and re-cap the size.

---

## 8. F9 / F10 — three distinct retrieval states collapse into one indistinguishable payload

```ts
function emptyResult(query: string): RagSearchResult {
  return { query, passages: [], conflicting: [], injectionWithheld: false, untrustedNotice: … }
}
// …
if (routed.decision === 'skip' || routed.decision === 'conflicting_evidence') {
  return emptyResult(query)
}
```

Meanwhile the model-facing description says:

> *"Passages that conflict with the query are returned in a separate `conflicting` list. … An empty
> `passages` list means the library had nothing relevant; answer from the conversation and your other
> tools."*

So **"library has nothing relevant"**, **"the router judged this a premise conflict"**, and **"the
router skipped retrieval"** all arrive as `{passages: [], conflicting: []}` — and the description
instructs the model to read that as the first. In my test the query treated a **draft** statute as
current law; if conflict detection is meant to catch a premise mismatch, that was the case for it, and
what the model received was "nothing relevant".

Compounding it (F10): `search` calls `routeQuery(deps.typesafe, { query })` with no context, so
`contextSupplied` is false and the premise branch can never fire. The in-code comment concedes this
("the early premise exit is inert"). Route-level `conflicting_evidence` is therefore effectively dead
code — and if it did fire, the early return would discard the evidence it was raised about.

**Fix:** give the result an explicit `reason: 'ok' | 'no_relevant' | 'premise_conflict' | 'skipped' |
'injection_filtered'`, populate `conflicting` on that path instead of dropping it, and align the tool
description with the real contract.

---

## 9. F11 / F12 / F13 — descriptions and semantics

**F11.** `tools/builtin/rag.ts` line 53 tells the model `list_documents` returns *"chunk count,
embedding dimensions, and when each was updated"*. `RagDocumentSummary` in `port.ts` has no `dims`
field, and `RagDocumentSummary` is a projection of `DocumentMeta`, which **does** carry `dims`,
`sourceName`, `byteSize`, `chunkSize`, `embedProviderId`, `embedModel`, `createdAt`. So the
information exists and is dropped at the port boundary while the description still promises it. This
propagates into the system prompt verbatim.

**Fix:** either add `dims` to the summary or delete the phrase. Consider also surfacing `createdAt`
and a document status; a `status: 'draft' | 'final'` would have prevented my test's central ambiguity.

**F12.** `topK` is a *pre-rerank* candidate count: `cosineTopK(queryVector, topK)` → Jev grading →
variable number of survivors. 8→6 and 5→2 are Jev exclusions, not truncation. The description
("return the passages judged relevant") never states this. Document it, or expose
`candidatesScanned` so the caller can reason about recall.

**F13.** `cosineTopK` sorts and slices (`hits.slice(0, limit)`) with **no score floor**. The only
relevance gate in the pipeline is the Jev model. Deliberate per the surrounding architecture, but it
means a top-K always returns K candidates no matter how weak, and there is no cheap deterministic
guard.

---

## 10. F14 — the verification surface is the display surface

```ts
// only ids the result actually returns become readable via get_chunk.
noteCapability(grade.id)
```

`noteCapability` runs only for grades the reranker did **not** exclude, and both `get_chunk` and
`verify_citation` refuse ids outside that set (returning `null` → `not_found`). Two consequences:

1. **Circularity.** A model can only verify a quotation against passages retrieval already decided to
   show it. If the reranker dropped the passage that supports a claim, verification cannot reach it —
   and the model is told the id does not exist.
2. **No context expansion.** There is no neighbour/parent fetch, so a "list everything in Article 32"
   question can never be completed. This is precisely why I could not read ordinals `0` and `7` of the
   draft statute, and why my previous answer had to be padded with general legal knowledge.

The comments frame this as an intended containment property ("this is not a way to browse the
corpus"), which is reasonable — but the cost is that the harness cannot answer multi-passage
questions and cannot refute its own reranker. A scoped `get_neighbors(chunkId, ±1)` inside the same
document would preserve containment while removing both problems.

---

## 11. F15 — why the suite did not catch any of this

`sortByRerank`/`verifyCitation` tests (l.304–370) use two passage shapes only:
`'The cat sat on the warm mat.'` and a short Vietnamese fixture.

Missing fixtures, i.e. exactly the failing inputs:

| Fixture | Currently covered | Would catch |
|---|---|---|
| Quotation wrapped in `“ ”` | no | F1 |
| Short true quote vs. 1024-token passage | no | F2, F3 |
| Paraphrase vs. long passage | no | F2 |
| Quote spanning a line break | no | F7 |
| NFD / detached-diacritic text | no | F5, F6 |
| Claim belonging to a different chunk | no | F3 |
| `search` with a premise conflict | no | F9 |
| Overlapping ordinals in one top-K | no | F8 |

Note that the existing "below the fuzzy floor" test compares two *unrelated short* sentences, so it
passes for the wrong reason and can never separate "true but low-overlap" from "invented".

---

## 12. Corpus observations (not harness bugs, but they shaped the test)

- The draft statute was ingested under a **hash filename**, so `titleOfFile` (which only strips the
  extension) produced a hash as the document title. Citations are untraceable for a human reader.
- The second document is NFD-corrupted and additionally has redundant internal duplication.
- The corpus contains only a **partial draft**, so **recall cannot be measured** from this session: I
  cannot distinguish a retrieval failure from absent data. Any harness evaluation needs at least one
  document whose answer is known to be present and complete.

---

## 13. Prioritized fixes

**P0 — correctness of `verify_citation`**
1. `normalizeForMatch`: NFC, strip quote marks, collapse whitespace. (F1)
2. Replace passage-wide Jaccard with claim-containment (or best window). (F2)
3. Below-floor ⇒ `unsupported`, `auto: false`; `fabricated` only on an explicit Jev negative. (F3)
4. Return matched span + fuzzy score so verdicts are auditable. (F3)

**P0 — text integrity**
5. NFC at extraction, at `contentTokens`, and at `normalizeForMatch`; keep `\p{M}` in the tokenizer;
   never insert a space between a base character and a combining mark. (F5, F6)
6. Strip repeated header/footer lines and trailing page numbers. (F7)

**P1 — retrieval**
7. Chunk on `Điều`/chapter/`\d+\.` boundaries; prefix chunks with provenance. (F4)
8. Dedup / MMR overlapping chunks before returning. (F8)
9. Add `reason` to the search payload; stop collapsing premise-conflict into "no results". (F9, F10)
10. Scoped neighbour expansion inside a document. (F14)

**P2 — contract and docs**
11. Fix or remove the "embedding dimensions" phrase in `list_documents`; consider a document status
    field. (F11)
12. Document `topK` as a pre-rerank candidate count; expose `candidatesScanned`. (F12)
13. Accented Vietnamese stopwords. (F6)

**Test suite** — add the eight fixtures in §11; they are the regression wall for everything above.

---

## 14. Not determined

- Whether the Jev grading calls in this session were served by the real model or a stub, so the
  relevance judgments behind the returned passages are unverified.
- Recall: impossible to measure against a partial-draft corpus (§12).
