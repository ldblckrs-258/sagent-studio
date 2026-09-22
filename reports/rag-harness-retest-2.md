# RAG Harness — Re-test Round 3

**Method:** black-box re-run of the full matrix, plus targeted code reads to attribute two results.

---

## 1. Result: both outstanding defects are fixed

| # | Finding | Status | Evidence |
|---|---|---|---|
| F5 | Syllable-split repair | **Fixed** | Clean and corrupted forms both → `verified`, `score: 1`; the corrupted form's `span` is the **clean** text |
| F8 | Sliding-window dedup | **Fixed** | `DEDUP_OVERLAP_CONTAINMENT = 0.6`; returned lists shrink from 7→4, 3→2, 2→1, and `conflicting` from 5→2 |

### F5 — repair landed at two layers

**Extraction** (`pdf.ts`) is now combining-mark aware: `const COMBINING_MARK = /\p{M}/u`, and the joiner requires *double* the word-space threshold after a combining mark so it "never splits off a leading combining mark".

**Matching** (`jev.ts`) now normalizes before comparing:

```ts
export function normalizeForMatch(value: string): string {
  return normalizeVietnameseSyllableSplits(
    value
      .normalize('NFC')
      .replace(/[\p{Pi}\p{Pf}"'«»„“”‘’]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}
```

Observed behaviour:

| Claim form | Verdict | Score | Span returned |
|---|---|---|---|
| `…pháp quyền xã hội chủ nghĩa của dân…` (correct) | `verified` | 1 | clean |
| `…pháp quyề n xã   hộ i chủ nghĩ a của dân…` (corrupted) | `verified` | 1 | `…pháp quyền xã hội chủ nghĩa của dân…` |

In the previous round the correct form scored **0.889** with no span (fuzzy path only). It is now `1` with a span — the repair is real, not a threshold tweak.

### Over-join risk — tested, clean

A syllable repair that joins across a combining mark could wrongly fuse legitimate boundaries such as `ở nước` or `và pháp luật`. Both were probed on a passage that contains them:

| Claim | Result | Span |
|---|---|---|
| `Ở nước Cộng hòa xã hội chủ nghĩa Việt Nam, các quyền con người…` | `verified`, score 1 | `…Ở nước Cộng hòa…` — space preserved |
| `tôn trọng, bảo vệ, bảo đảm theo Hiến pháp và pháp luật` | `verified`, score 1 | `…pháp luật` — repaired from the stored `pháp luậ t`, space preserved |

So the heuristic repairs `luậ t → luật` while leaving genuine word gaps intact. Safe on every boundary sampled.

### F8 — second, looser criterion added

```ts
const DEDUP_CONTAINMENT = 0.9          // genuinely duplicated passages
const DEDUP_OVERLAP_CONTAINMENT = 0.6  // sliding-window overlap
// …
if (forward >= DEDUP_CONTAINMENT && backward >= DEDUP_CONTAINMENT) return true
return Math.max(forward, backward) >= DEDUP_OVERLAP_CONTAINMENT
```

The in-code comment states the previous logic "lands well below `DEDUP_CONTAINMENT`; the mutual check alone missed it" — which is exactly the diagnosis from round 2. Measured effect on identical queries:

| Query | Round 2 | Round 3 |
|---|---|---|
| `trách nhiệm của Bộ trưởng Bộ Ngoại giao` (`candidatesScanned: 8`) | 7 passages | **4 passages** |
| `bảo hộ công dân … nhiệm vụ lãnh sự` (5 scanned) | 3 | **2** |
| `Chính phủ gồm Thủ tướng…` (6 scanned) | 2 | **1** |
| `premise_conflict` probe (5 scanned) | 5 in `conflicting` | **2** |

In every case the dropped passages were the overlapping siblings of retained ones, and `candidatesScanned` is unchanged — so the reduction is dedup, not a ranking change.

---

## 2. Regression sweep — nothing broke

| Probe | Expected | Observed |
|---|---|---|
| Verbatim claim wrapped in `“ ”` | `verified`, score 1, span | ✅ |
| Invented claim ("tuyên chiến") | `fabricated`, `auto: false` | ✅ `fabricated`, conf 0.66, auto false |
| Unrelated claim ("pizza") | `unsupported`, not `fabricated` | ✅ `unsupported`, `confidence: null`, `auto: false`, score 0 |
| Off-topic query | `reason: "skipped"` | ✅ |
| False-premise query | `reason: "premise_conflict"`, `passages: []` | ✅, `conflicting` populated |

All four citation verdicts remain reachable and distinguishable; `auto` stays false except on a deterministic match or high-confidence Jev support.

---

## 3. Blocker: the corpus was not re-processed, so F4 and F7 stay unverified

`updatedAt` advanced on all four documents (`1790063964724`–`1790064000796`), suggesting a re-ingest. But the payload is **byte-identical to the previous round**:

| Document | chunkCount (prev → now) | chunk ids | Boundaries |
|---|---|---|---|
| `a6a9ee9a…` (draft statute) | 8 → 8 | identical (`ff103953`, `b58e7478`, …) | mid-sentence, e.g. `" quy định của pháp luật Việt Nam và…"` |
| `lich-su…` | 3 → 3 | identical (`bb06c477`) | identical |
| `672488` | 82 → 82 | identical | identical |
| `52-vbhn-vpqh` | 33 → 33 | identical (`00bef1bc`, `d73f11dc`, `49563e8b`) | identical |

And the text still carries every pre-fix artefact:

- split syllables: `nư ớc`, `luậ t`, `trậ t tự`, `công nhậ n`, `tậ p thể`, `cộ ng`, `xử lý`
- decomposed, un-composed marks: `quyề`, `hộ`, `nghĩ`
- uncollapsed multi-space runs: `xã   hộ i`
- page-number glue: `và Thủ24`, `xã hội.6`, `”;6`, `như sau:18`, `pháp luậ t.9`

If extraction had re-run with the NFC normalizer, the decomposed marks and the multi-space runs would both be gone, and the new chunker (`LEGAL_HEADING`, sentence-boundary splitting) would almost certainly have moved chunk boundaries. Neither happened.

**Two possible readings**, and they are worth distinguishing:

1. the re-ingest re-indexed/re-embedded but **skipped re-extraction**, so the stored text is stale; or
2. extraction did re-run and the artifact arrives through a path the joiner fix does not cover (e.g. the PDF emits the space as its own text item rather than the joiner inserting it).

**Consequences either way:**

- **F4** (Điều-aware / sentence-aligned chunking) and **F7** (running-header/footer and page-number stripping) are implemented in code (`LEGAL_HEADING`, `repeatedFurniture`, `TRAILING_PAGE_NUMBER`) but cannot be observed on the current corpus. The old mid-sentence openings persist.
- The model still **reads** corrupted Vietnamese from these chunks, and accepts them as citations (`docTitle` + `text` are what reaches the prompt).
- The vectors for those chunks were most likely built from the same corrupted text, so retrieval for these documents is still ranking degraded tokens — repairing the matcher does not repair the index.

Because `normalizeVietnameseSyllableSplits` repairs at match time, **verification now silently succeeds on data that is still broken on disk**. That is good defence in depth, but it also masks the ingest defect: a citation can verify cleanly against a passage whose stored text is unusable. Worth deciding deliberately which layer owns the repair.

---

## 4. Remaining items

1. **Re-ingest and confirm** — delete a document and re-add it, then check that `chunkCount`, chunk ids, and boundaries actually change. If they do not, the ingest path is short-circuiting and F4/F7 stay unverifiable.
2. **F4 / F7 validation** — only possible against a freshly processed PDF of the same class.
3. **`fabricated` vs `unsupported`** — a claim the passage is merely silent about ("quyền tuyên chiến") is labelled `fabricated` via `is_fabricated` rather than `unsupported`. Low risk (`confidence: 0.66`, `auto: false`), but the distinction is worth pinning down in the Jev prompt.
4. **Decide where syllable repair belongs** — matcher only, or ingest plus matcher. Today it is matcher-side, which leaves the corpus and its vectors degraded.

---

## 5. Summary

**Verified fixed:** F1, F2, F3, F5, F6, F8, F9, F10, F11, F12, F14 — the whole citation-verification surface and the retrieval dedup path are now correct, and nothing regressed.

**Implemented but unverifiable on live data:** F4, F7 — blocked by a corpus that did not change despite a re-ingest.

**No new defects found.** The one new heuristic introduced this round (syllable repair) was probed for over-joining and behaved correctly on every sample.
