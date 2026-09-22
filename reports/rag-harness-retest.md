# RAG Harness — Re-test After Fixes

**Date of run:** this session. **Method:** black-box re-run of the original reproduction matrix through the
live tools, then targeted code reads only where a behavioural result was ambiguous.

**Corpus at test time** (grown since the first review — 4 documents now):

| id | title | chunks | dims | created |
|---|---|---|---|---|
| `2075f866…` | `52-vbhn-vpqh` | 33 | 1024 | 1790026507105 |
| `85eb9628…` | `672488` | 82 | 1024 | 1790026111389 |
| `ca2eb273…` | `a6a9ee9a470f4d74bab2fb834818a37f` (draft statute) | 8 | 1024 | 1790025655588 |
| `679b2a0e…` | `lich-su-va-y-nghia-cua-ngay-phap-luat-viet-nam-09…` | 3 | 1024 | 1790024573095 |

---

## 1. Status of the original findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| F1 | Quote marks not stripped | **Fixed** | Verbatim claim wrapped in `“ ”` → `verified`, `score: 1`, `span` returned |
| F2 | Symmetric Jaccard against whole passage | **Fixed** | Paraphrase → reached Jev: `verified`, `confidence: 0.92`, `score: 0.85` |
| F3 | `fabricated` as fallback, auto-accepted | **Fixed** | Below floor → `unsupported`, `confidence: null`, `auto: false`; invented claim → `fabricated` only via explicit Jev negative; wrong-chunk claim → `unsupported` |
| F4 | No article/sentence-aware chunking | **Not fixed** | `672488` ordinal 17 opens mid-word: `"ủi ro về mất mát"` (← `rủi ro`); `a6a9ee9a` ordinal 1 opens mid-sentence |
| F5 | PDF space-insertion + no NFC | **Partially fixed** | NFC added, but the intruded space is not repaired — see §2 |
| F6 | `\p{M}` dropped by tokenizer; unaccented stopwords | **Fixed** | `contentTokens` now `.normalize('NFC')`; a clean-form claim matched a corrupted passage |
| F7 | Page furniture / page numbers kept | **Code present, unvalidated** | `repeatedFurniture` + `TRAILING_PAGE_NUMBER` exist; corpus is stale so no post-fix PDF could be observed |
| F8 | Overlapping chunks returned un-deduped | **Partially fixed** | `dedupePassages` added, but its criterion cannot catch sliding-window overlap — see §3 |
| F9 | `skip` / premise-conflict / no-relevant collapsed into one payload | **Fixed** | `reason` observed as `ok`, `skipped`, `premise_conflict`; `conflicting` now populated |
| F10 | Route-level premise branch dead | **Fixed** | Premise-conflict query returned `reason: "premise_conflict"` with 5 passages in `conflicting` |
| F11 | `list_documents` promised embedding dimensions | **Fixed** | Payload now carries `dims` and `createdAt` |
| F12 | `topK` semantics undocumented | **Fixed** | `candidatesScanned` now returned (8 requested → 8 scanned → 7 returned) |
| F13 | `cosineTopK` has no score floor | Unchanged (by design) | Only relevance gate remains the Jev model |
| F14 | No context expansion; verification surface == display surface | **Fixed** | `get_neighbors` exists and works — see §4 |
| F15 | Test suite only used ~7-word passages | Not verifiable from outside | — |

---

## 2. F5 residual: NFC composes the diacritic but leaves the intruded space

This is the one still-broken item that is **proven against the running code**, not against stale data.

The stored text of the `lich-su…` document contains syllable-split artefacts such as
`quyề n`, `cộ ng`, `nghĩ a`. A verbatim claim reproduced in that corrupted form verifies
deterministically:

```
claim:  "Nhà nước pháp quyề n xã   hộ i chủ nghĩ a của dân, do dân và vì dân"
→ verdict: verified, score: 1
→ span:   "Nhà nước pháp quyề n xã hộ i chủ nghĩ a của dân, do dân và vì dân"
```

The span is the **post-NFC** form the harness matched on. NFC composed the detached combining
marks (`quyề` → `quyề`) but the interloping spaces survived (`quyề n`, `hộ i`, `nghĩ a`).

The same claim written in **correct Vietnamese** does not match deterministically:

```
claim:  "Nhà nước pháp quyền xã hội chủ nghĩa của dân, do dân và vì dân"
→ verdict: verified, confidence: 1, score: 0.889   (fuzzy path, not exact)
```

`score` is below `1` and no `span` is returned, i.e. the fast path was missed; only the containment
gate plus a Jev call rescued the verdict. In other words, **a user or model quoting the document
correctly cannot produce a deterministic match — the quotation has to reproduce the extraction
defect.**

`normalizeWhitespace` (which gained `.normalize('NFC')`) collapses whitespace *runs* but never
removes a space that sits inside a word, so NFC alone cannot close this gap. A repair pass is
missing: after NFC, rejoin `\p{L}\p{M}\s+(?=\p{L})` where the space was injected between a
diacritic-bearing base and the next letter of the same syllable.

### Corpus staleness blocks full validation

Three of four documents still hold pre-fix text — `bb06c477…` came back byte-identical to the
pre-fix run, and the newly added `52-vbhn-vpqh` shows the same artefact class
(`nư ớc`, `luậ t`, `trậ t tự`, `công nhậ n`, `cộng đồ ng`, `chế độ tậ p thể`, `văn b ản`, `quý…`).
Their **vectors were computed on that text**, so retrieval for those documents still ranks
corrupted tokens.

Ingest is one-shot, so the extraction fixes are **not retroactive**. To validate F5/F7 the documents
must be deleted and re-ingested. Note that `672488` (Luật Thương mại) is entirely clean
(`hàng hóa`, `chuyển rủi ro`, `Điều 60.`), which shows the pipeline can produce clean text — but it
is ambiguous whether that file was ingested post-fix or is simply a well-encoded PDF.

---

## 3. F8 residual: the dedup threshold cannot catch window overlap

`dedupePassages` (`port.ts`) requires **mutual** containment:

```ts
const DEDUP_CONTAINMENT = 0.9
const duplicate = kept.some(
  (existing) =>
    tokenOverlapScore(passage.text, existing.text) >= DEDUP_CONTAINMENT &&
    tokenOverlapScore(existing.text, passage.text) >= DEDUP_CONTAINMENT,
)
```

For chunks produced by sliding-window overlap, one direction's containment is bounded by
`overlap / chunk length`, which in practice lands around 0.5–0.75. A mutual floor of `0.9` is
therefore unreachable for exactly the case it is meant to catch — it only collapses near-identical
passages, not overlapping windows.

Observed: the same sentence verifies with `score: 1` against **two passages returned together in one
top-K**:

| chunk | ordinal | `verify_citation` of the shared sentence |
|---|---|---|
| `533f97f4…` | 5 | `verified`, `score: 1` |
| `2804cbd1…` | 4 | `verified`, `score: 1` |

The same failure is visible in the premise-conflict result, where **all five** passages placed in
`conflicting` (ordinals 3, 4, 5, 6, 7 of one document) overlap pairwise and `dedupePassages` collapsed
none of them. Roughly half of every returned list is still redundant context.

Suggested criterion: compare the smaller passage against the other with a **one-directional**
containment (asymmetric) around 0.6–0.7, or compare only the shared boundary region.

---

## 4. F14 fixed — and it materially changes what the harness can answer

`get_neighbors(chunkId, radius)` works: anchored on `ff103953…` (ordinal 6) with `radius: 2` it
returned ordinals 4, 5 and 7, in ordinal order, and those ids became readable afterwards. The
document tail is now reachable, including the provisions that were previously unobtainable:

> `Luật này có hiệu lực thi hành từ ngày 01 tháng 7 năm 2026.`

This closes the gap that in the first review forced an answer to be padded with general knowledge.
Two notes:

- Neighbours are returned **un-deduped** (ordinals 4 and 5 heavily overlap). That is defensible for a
  neighbour API, whose purpose is contiguous context — the problem is the `search` path, not this one.
- `radius` is capped at 3, so the full span of a very long article is still only reachable by chaining
  anchors.

---

## 5. Verification matrix (`verify_citation`, current build)

| Claim | Verdict | Confidence | Score | Auto | Interpretation |
|---|---|---|---|---|---|
| Verbatim, wrapped in `“ ”` | `verified` | null | 1 | true | deterministic fast path, span returned |
| Verbatim spanning a line break | `verified` | null | 1 | true | whitespace collapse works |
| Paraphrase (3-year extension) | `verified` | 0.92 | 0.85 | true | reaches Jev |
| Invented ("tuyên chiến") | `fabricated` | 0.64 | 0.667 | false | explicit Jev negative, not auto-accepted |
| True statement absent from this chunk | `unsupported` | 0.99 | 0.727 | false | correctly not labelled fabricated |
| Unrelated (pizza) | `unsupported` | null | 0 | false | below-floor branch is not `fabricated` |

All four verdicts are now reachable and distinguishable, and `auto` is `false` on everything except
a deterministic match or a high-confidence Jev support. `score` and `span` make the exact path
auditable.

One semantic point to watch: the invented "tuyên chiến" claim is labelled `fabricated` (via the
explicit `is_fabricated` signal) although the passage is merely silent on war powers, which would
read as `unsupported`. Because it carries `confidence: 0.64` and `auto: false`, a reviewer sees it —
acceptable, but the distinction between "the source says nothing" and "the source contradicts this"
is worth pinning down in the Jev prompt.

---

## 6. Search result contract

| `reason` | Trigger observed | `passages` | `conflicting` |
|---|---|---|---|
| `ok` | normal hit | 7 | 0 |
| `skipped` | off-topic (`cách nấu phở bò`) | 0 | 0 |
| `premise_conflict` | false-premise legal question | 0 | 5 |

`candidatesScanned` is present on all three. `no_relevant` and `injection_filtered` were not
triggered in this run and remain unverified.

`list_documents` now returns `dims` and `createdAt`, matching its description.

---

## 7. Remaining work, in priority order

1. **Space repair after NFC** (§2) — the only proven live defect in text handling. Without it,
   correct Vietnamese quotations never take the deterministic path, and the token stream stays
   fragmented for every affected document.
2. **Re-ingest the library** (§2) — extraction fixes are not retroactive; three of four documents
   carry pre-fix text and pre-fix vectors.
3. **Dedup criterion** (§3) — move from mutual 0.9 containment to asymmetric boundary-overlap
   comparison; roughly half of every result list is redundant until then.
4. **Chunk boundaries** (F4) — mid-word and mid-clause cuts persist; `Điều`/`Chương` boundaries are
   still not honoured.
5. **Confirm the F15 fixtures exist** — in particular a long-passage true quote and an
   NFD/split-syllable case, so §2 regresses loudly instead of silently.

---

## 8. Verified and not verified

**Verified fixed:** F1, F2, F3, F9, F10, F11, F12, F14, and the NFC half of F6.

**Verified still broken:** F5 (space repair), F8 (dedup criterion), F4 (chunk boundaries).

**Present in code but unvalidated against real data:** F7 (page furniture removal) — needs a
re-ingest to observe.

**Not tested:** F15 (test suite contents), `no_relevant` / `injection_filtered` reasons, behaviour
with a genuinely clean post-fix PDF of the same class as `52-vbhn-vpqh`.
