---
title: "Phase 3: Jev Judgment Module"
status: done
---

# Phase 3: Jev Judgment Module

<!-- Updated: Validation Session 1 - citation fuzzy prefilter and jev-latest model -->

## Context Links

- [`plan.md`](./plan.md) — constraints, thresholds, and the Jev capability contract.
- [`research/researcher-01-typesafe-jev.md`](./research/researcher-01-typesafe-jev.md) §2
  one request per state, §3 primitives, §4 confidence, §5 batching economics, §6 the three
  load-bearing cookbooks, §7 calibration, §8 limits and retries, §12 failure modes.
- [`phase-01-document-store-and-ingest.md`](./phase-01-document-store-and-ingest.md) and
  [`phase-02-local-retrieval.md`](./phase-02-local-retrieval.md) — the candidate shape this
  module consumes.

## Overview

Implement the judgment layer as one module, `src/rag/jev.ts`, exposing functions over a
`TypeSafeClient` and an explicit `options.cache`. Four call sites: route a query, select a
query formulation, grade a query-passage pair, and verify a citation. Every threshold, sort,
and routing decision lives in code; the cached value is the raw answer, so policy changes
cost no API calls, and the cache itself is supplied by the caller rather than held here.

## Key Insights

- One `client.systemOne({ state, questions })` request answers many independent questions
  over the same state in parallel, and the question key you choose is returned untouched
  and never sent to the model. Write the full condition in `instructions`, not in the key
  name.
- A shared question object must be declared `as const`, or Score `criteria` widens to
  `string[]` and stops satisfying `ScoreCriteria`. This is verified against the installed
  dist, not documented.
- Criteria shapes differ and are load-bearing: Choice takes a label to description map
  (at most 255 options); Score takes an ordered array of two to ten levels that describe
  situations, never degrees, and returns a probability-weighted mean that can fall between
  levels; Noul takes one condition per question with high meaning yes, and carries no
  separate confidence.
- Confidence is a statistic over the answer's own probability distribution. It describes
  the answer, not its correctness. Noul and Choice on the same proposition can disagree,
  so a threshold calibrated on one type is never reused on another.
- Thresholds and routing are copied from the cookbooks by name.
  `classifying_rag_passages` supplies `injection_max 0.70`, `contradicts_min 0.70`,
  `relevant_min 0.45`, `evidence_min 0.55` and the ordered `route()` where injection is
  checked first because it is a security decision, contradiction next because a
  premise-denying passage usually also states something usable, then the relevance floor,
  then evidence.   `rerank_typesafe` supplies the no-threshold rule: sort by the returned
  Noul and let the gate decide inclusion. `citation_check` supplies the deterministic
  normalized string match before any model call, the fuzzy prefilter that follows it, and
  `AUTO_ACCEPT = 0.8`.
  `parallel_questions` supplies the cost argument for one request per state instead of one
  per question.
- Citation verification is a two-stage prefilter, not a substring equality test. The
  deterministic normalized substring check runs first and short-circuits to `verified`; when
  it misses, a token-overlap fuzzy score decides whether the claim is close enough to
  deserve the Jev Choice, and only a score below the documented `citationFuzzyMin` floor is
  `fabricated` with no Jev call. The floor is a threshold like any other — clamped to
  `[0, 1]`, overridable per call, and tuned in one place — and it is the knob that trades a
  false `fabricated` verdict against an extra Choice call.
- The cookbook's own caveat is quoted in the module comment: the injection question is one
  filter, a passage under the threshold still reaches the prompt, and nothing here is a
  security boundary.
- Timeout is per attempt, and `maxRetries` defaults to 2, so a request can take three
  attempts. Set an explicit 60s timeout (`SYSTEM_ONE_TIMEOUT_MS = 60_000`) and pass an
  `AbortSignal` so a cancelled retrieval aborts in-flight calls. The single construction
  site is phase 4: `createTypeSafe(settings, { timeoutMs: SYSTEM_ONE_TIMEOUT_MS })`.
- The request cap (about 1,200 per minute) binds before the token cap, so the fan-out is a
  pool of four requests, matching the cookbook's `max_workers=4`. A failed or rate-limited
  pair must not take the batch with it: contain per-pair failures, surface them, and gate
  the next dispatch on `RateLimitError.retryAfterMs`.
- There is no module-level default cache. The answer cache arrives through
  `options.cache`, and the session that owns the port creates it; a module singleton would
  outlive a lock and hold judgments about decrypted passages.
- `logLevel` stays `warn`: SDK debug logging writes request bodies, and our bodies contain
  decrypted passage text.

## Requirements

- `THRESHOLDS` is one exported object holding every routing number and the pool size.
- `resolveThresholds` clamps every known threshold override to `[0, 1]` — not only
  `concurrency`, which is clamped to `[1, 8]` — and passes unknown keys through untouched.
- `routeQuery(client, { query, context? }, options?)` makes exactly one request with two
  Noul questions, `needs_retrieval` and `premise_valid`, and returns both judgements plus
  the routing decision computed in code. `premise_valid` compares the query's premise
  against a caller-supplied `context`; with no context it is not decisive, and
  `gradePair`'s `contradicts_premise` is the primary false-premise path.
- `selectQuery(client, question, candidates, options?)` makes at most one Choice request
  over code-generated candidates and returns the highest-probability candidate.
- `gradePair(client, query, passage, options?)` makes exactly one request carrying five
  questions — `rerank` (Score), `is_relevant`, `has_evidence`, `contradicts_premise`,
  `contains_injection` (Nouls) — and returns the raw answers plus the code-computed
  decision.
- `gradePairs(client, query, passages, options?)` runs `gradePair` through a bounded pool,
  reuses cached answers, deduplicates repeated chunk ids, and preserves input order. It
  contains per-pair failures instead of rejecting the batch: a failed, timed-out, or
  rate-limited pair is recorded and excluded, reported in the result's `failed` field, and
  the remaining pairs still grade. A client-side throttle keyed on
  `RateLimitError.retryAfterMs` delays the next dispatch, and the caller's signal bounds
  total wall time.
- `verifyCitation(client, claim, passageText, options?)` runs the deterministic normalized
  substring check first and short-circuits to `verified` when it hits. When it misses, a
  token-overlap fuzzy score is computed and only a score below the documented
  `citationFuzzyMin` floor returns `fabricated` with no Jev call; at or above the floor the
  claim proceeds to at most one Choice request, returning
  `verified | contradicted | unsupported | fabricated`.
- The answer cache is keyed by the SHA-1 of the query and the passage id, stores raw
  answers, and is clearable. It is never a module-level singleton: it arrives through
  `options.cache` and defaults to nothing, with the session that owns the port supplying
  the instance (phase 4). It is generation-guarded the way `src/ai/client-cache.ts` is, or
  cleared from the same session lifecycle hook as the vector index.
- Every function accepts an `AbortSignal` and an optional threshold override.
- Usage (call count and tokens) is accumulated so cost per retrieval is observable.
- A withheld passage is reported by reason code, route decision, and counts only. The raw
  withheld payload is never echoed into a tool result or a prompt.

## Architecture

```
THRESHOLDS { injectionMax, contradictsMin, relevantMin, evidenceMin,
             autoAccept, needsRetrievalMin, premiseValidMin, citationFuzzyMin,
             concurrency }
resolveThresholds(rag.thresholds, rag.concurrency) -> effective thresholds
  known threshold keys clamped to [0, 1]; concurrency clamped to [1, 8]

routeQuery(client, { query, context? }, options)     ONE request, 2 Nouls
  -> needs_retrieval <= 0.5        => skip retrieval
  -> premise_valid  <= 0.5         => conflicting_evidence, only when context was supplied
     (no context on the tool path: the early exit is inert)

selectQuery(client, question, candidates, options)   <= ONE Choice request
  candidates generated in code: original, stopword-stripped, clause splits
  -> argmax(probabilities); one candidate short-circuits with no request

gradePair(client, query, { id, text }, options)      ONE request, 5 questions
  -> route():
       injection  > 0.70 -> exclude
       contradicts> 0.70 -> conflicting_evidence
       relevant   < 0.45 -> exclude
       evidence   > 0.55 -> include
       else              -> exclude
  -> rerank sorts separately with NO threshold

gradePairs(client, query, passages, options)         pool of 4 + cache from options.cache
  -> per-pair containment: a failed pair lands in `failed`, never rejects the batch
  -> throttle: RateLimitError.retryAfterMs gates the next dispatch
  -> bound: the caller's signal bounds total wall time
verifyCitation(client, claim, passageText, options)
  normalize
  -> exact normalized substring?            => verified (no Jev call)
  -> token-overlap score < citationFuzzyMin => fabricated (no Jev call)
  -> else Choice over supports|contradicts|says_nothing, auto = confidence >= 0.8
```

## Related Code Files

Create:

- `src/rag/jev.ts` — `THRESHOLDS`, `resolveThresholds`, `createJevCache`,
  `clearJevCache(cache)`, `routeQuery`, `selectQuery`, `gradePair`, `gradePairs`,
  `verifyCitation`, `generateQueryCandidates`, `normalizeForMatch`, `tokenOverlapScore`,
  `jevsUsage`, `SYSTEM_ONE_TIMEOUT_MS`. `JevCache` is a value type passed through
  `options.cache?: JevCache`; the module holds no default instance.
- `src/rag/fixtures.ts` — the Vietnamese passage and query fixture and the canned
  `SystemOneResult` shapes the tests return from the mocked client. Adversarial passage
  fixtures are phase 5's, in its own file, so no phase shares a fixture module.
- `src/rag/jev.test.ts`

Modify:

- `src/ai/typesafe.ts` — add an optional second parameter
  `options?: { timeoutMs?: number }` and forward it as the client's `timeout`. Additive;
  the existing call shape and `logLevel: 'warn'` are unchanged.
- `src/ai/typesafe.test.ts` — assert the timeout is applied when passed and that the
  client is still constructed with one argument.

## Implementation Steps

1. In `src/rag/jev.ts`, declare `THRESHOLDS` with `injectionMax: 0.7`,
   `contradictsMin: 0.7`, `relevantMin: 0.45`, `evidenceMin: 0.55`, `autoAccept: 0.8`,
   `needsRetrievalMin: 0.5`, `premiseValidMin: 0.5`, `citationFuzzyMin: 0.35`, and
   `concurrency: 4`. Comment each
   with the cookbook it comes from, and state explicitly that the two route thresholds are
   our own additions, since `classifying_rag_passages` publishes only the four grading
   numbers. Document `citationFuzzyMin` as a deliberately low starting floor: it is low
   enough that a lightly reworded quotation still reaches the Jev Choice rather than being
   declared fabricated, and high enough to skip the call for a claim that shares almost no
   content tokens with the passage; it is calibrated against the fixture set in step 12.
2. Export `resolveThresholds(overrides?: Record<string, number>, concurrency?: number)`
   that starts from `THRESHOLDS`, applies known override keys, clamps every known threshold
   key (`injectionMax`, `contradictsMin`, `relevantMin`, `evidenceMin`, `autoAccept`,
   `needsRetrievalMin`, `premiseValidMin`, `citationFuzzyMin`) to `[0, 1]`, clamps
   `concurrency` to `[1, 8]`,
   and leaves unknown keys untouched. The input this guards against is a persisted
   `rag.thresholds` blob written by an older build or hand-edited by the user.
3. Declare the three shared question sets as module constants with `as const`, and quote
   the cookbook phrasing in the `instructions` strings so the condition is in the
   instruction rather than the key. `gradePair` sends all five in one request with
   `state: { query, passage: { id, text } }`.
4. Implement `routeQuery` with `state: { query, context }`, where `context` is optional,
   and the two Noul questions `needs_retrieval` and `premise_valid`. Document in the module
   that `premise_valid` compares the query's premise against a caller-supplied conversation
   context only: with no context it is not decisive and its early `conflicting_evidence`
   exit is inert, and a premise the corpus contradicts is caught later by `gradePair`'s
   `contradicts_premise`, which is the primary path for a false-premise query.
5. Implement `generateQueryCandidates(question)` returning a deduplicated list: the trimmed
   original, a stopword-stripped form, one candidate per clause split on `?`, `.`, `,`,
   `;`, and ` and `, and the quoted spans on their own. Cap the list at eight and preserve
   the original first so an argmax tie falls back to it.
6. Implement `selectQuery` as a single Choice whose criteria map is `{ c0: candidate0, ... }`,
   returning the highest-probability candidate together with its confidence and the full
   probability map. When `generateQueryCandidates` leaves a single candidate, return it
   with `confidence: null` and make no request.
7. Implement the code-side `route(query, answers, thresholds)` helper with the
   first-match-wins order from the `classifying_rag_passages` cookbook — injection, then
   contradiction, then relevance, then evidence — and export the decision as
   `include | conflicting_evidence | exclude`.
8. Implement `createPool(limit)` with `run(tasks)` preserving output order and never
   exceeding `limit` in flight. Implement `toCacheKey(query, passageId)` as the hex SHA-1 of
   `` `${query}\n${passageId}` `` computed with `crypto.subtle.digest`. Implement
   `createJevCache()` returning `{ get, set, clear, size, usage }` where the cached value is
   the raw `PairAnswers`, stamped with the generation the way `src/ai/client-cache.ts` does,
   so a `get` under a different generation misses instead of returning a pre-lock judgment.
   Export `clearJevCache(cache)` that clears a passed instance. Create no module-level
   default cache and export none: every function takes `options.cache?: JevCache` and skips
   the cache when it is absent, and phase 4 supplies a per-port instance.
9. Implement `gradePair` to return
   `{ answers, rerank, decision, cached, model, usage, failure? }`, and `gradePairs` to
   consult the cache per key, skip cached pairs, deduplicate repeated ids, and run the
   remainder through the pool with the effective concurrency. Contain per-pair failures with
   `Promise.allSettled` or a per-task try/catch so a failed, timed-out, or 429 pair is
   recorded in a `failed: [{ id, reason }]` array and excluded while the other pairs still
   resolve; never reject the whole batch for one pair. Key the client-side throttle on
   `RateLimitError.retryAfterMs` so a 429 delays the next dispatch rather than burning the
   remaining budget, and let the caller's `signal` bound total wall time. Sorting for rerank
   happens in the caller: expose `sortByRerank(grades)` with no threshold.
10. Implement `normalizeForMatch(value)` as trim, whitespace-run collapse, and
    curly-to-straight quote folding, leaving case intact because a case change is a
    rewording. Implement `tokenOverlapScore(claim, passage)` as the Jaccard overlap of
    lowercased, stopword-stripped content tokens. Implement `verifyCitation` as a two-stage
    prefilter: when the normalized claim is a substring of the normalized passage, return
    `verified` immediately with no Jev call; otherwise compute `tokenOverlapScore` and, when
    it is below `citationFuzzyMin`, return `fabricated` with `confidence: null` and
    `auto: true`, still with no Jev call; otherwise make one Choice request over
    `supports`, `contradicts`, and `says_nothing`, mapping to `verified`, `contradicted`,
    and `unsupported` with `auto = confidence >= autoAccept`. Document in a comment that the
    fuzzy floor is a tunable starting point rather than a fixed law: the exact match is only
    a fast path, the fuzzy score is what a reworded quotation falls back to, and the floor
    plus the token-overlap metric are the two knobs to calibrate if fabricated verdicts or
    Jev call volume drift.
11. Pass `{ signal }` as the request options on every `systemOne` call. Keep
    `SYSTEM_ONE_TIMEOUT_MS = 60_000` and construct no client here: the single construction
    site is phase 4's `createTypeSafe(settings, { timeoutMs: SYSTEM_ONE_TIMEOUT_MS })`,
    which hands the finished client to the port. The client honors `settings.typesafe.model`
    (`jev-latest` by default) and no phase pins a versioned id; each judgment carries the SDK
    response's `result.model` — the versioned id that answered — into the returned `model`
    field, so a run stays reproducible in the log while the alias moves.
12. Write `src/rag/jev.test.ts` against a mocked client typed as `unknown as
    TypeSafeClient` whose `systemOne` is a `vi.fn()` returning canned results from
    `src/rag/fixtures.ts`. Cover: routing at and around each threshold, first-match-wins
    ordering, one request per pair, the pool never exceeding four in flight, cache reuse
    and deduplication, order preservation, the single-candidate short circuit, the
    exact-substring citation path making zero calls, the below-floor fuzzy citation path
    making zero calls and returning `fabricated`, the paraphrase at or above the floor
    making exactly one Choice call, the `AUTO_ACCEPT` boundary at exactly 0.8, signal
    forwarding, an out-of-range persisted override being clamped to `[0, 1]` (including
    `citationFuzzyMin`), one pair rejecting while the rest still grade with the failure
    reported in `failed`, and the Vietnamese fixture. Then run `pnpm test`, `pnpm lint`, and
    `pnpm build`.

## Todo

- [x] Add the optional `timeoutMs` parameter to `createTypeSafe` and test it; leave
      construction to phase 4.
- [x] Declare `THRESHOLDS` (including `citationFuzzyMin`) and `resolveThresholds` with
      cookbook citations and `[0, 1]` clamps.
- [x] Declare the shared question sets `as const` with full conditions in `instructions`.
- [x] Implement `routeQuery`, `selectQuery`, `gradePair`, `gradePairs`, `verifyCitation`.
- [x] Implement the pool, the generation-guarded `JevCache` threaded via `options.cache`,
      the per-pair failure containment and `retryAfterMs` throttle, and usage accounting.
- [x] Return a reason code and counts for a withheld passage, never the payload.
- [x] Implement `generateQueryCandidates` and `normalizeForMatch`, plus `tokenOverlapScore`
      and the `citationFuzzyMin` prefilter in `verifyCitation`.
- [x] Add `src/rag/fixtures.ts` with the Vietnamese fixture and the canned result shapes.
- [x] Add `src/rag/jev.test.ts` and make the three gates pass.

## Success Criteria

- `src/rag/jev.test.ts` proves `gradePair` issues exactly one `systemOne` call carrying five
  answers and that `route` follows injection, contradiction, relevance, evidence order with
  a first-match win.
- The same file proves `gradePairs` over twelve passages never exceeds four concurrent
  calls, returns input order, performs no second call for a cached or duplicated passage,
  and that changing thresholds after a cached run makes no new call.
- The same file proves one rejecting pair does not reject the batch: the remaining pairs
  still grade, and the failing id is reported in `failed` with its reason. It proves the
  cache used is the instance passed in `options.cache`, and that a generation bump makes a
  previously cached pair miss rather than return a pre-lock answer.
- `resolveThresholds` is proven to clamp an out-of-range persisted override into `[0, 1]`,
  including `citationFuzzyMin`, to clamp `concurrency` into `[1, 8]`, and to leave unknown
  keys untouched.
- A withheld passage is proven to be reported as a reason code plus counts, with the
  payload text absent from the returned object.
- `routeQuery` is proven to make one call with two Noul answers, to return the skip decision
  at the documented `needsRetrievalMin`, to return `conflicting_evidence` when a context was
  supplied and the premise fails, and to leave that exit inert when no context is supplied.
- `selectQuery` is proven to choose the highest-probability candidate, to make no request
  for a single deduplicated candidate, and to cap the option list at eight.
- `verifyCitation` is proven to return `verified` with zero calls on an exact normalized
  substring hit; to compute the fuzzy score and return `fabricated` with zero calls for a
  claim below `citationFuzzyMin`; to make exactly one Choice call for a paraphrased claim at
  or above the floor; and to map `supports`, `contradicts`, and `says_nothing` to their
  verdicts, accepting at exactly `0.8` and not below.
- The Vietnamese fixture proves the passage text is sent verbatim as state and that routing
  follows the returned numbers, with a comment stating that this proves plumbing only and
  that Jev's non-English accuracy remains a calibration task on the user's own documents.
- `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| Thresholds are treated as defaults rather than starting points | They live in one object with cookbook citations, are overridable per call, and the cache stores raw answers so re-tuning is free |
| A reworded but genuine quotation is reported as fabricated | The exact normalized substring is only a fast path: a miss falls through to `tokenOverlapScore`, and only a score below `citationFuzzyMin` is `fabricated`, so a paraphrase that shares content tokens still reaches the Jev Choice |
| The fuzzy floor admits unrelated claims to Jev and inflates call volume | The floor is a documented, `[0, 1]`-clamped, per-call-overridable threshold with a deliberately low start; the fixture set pins its behaviour and the usage counters make a drift visible |
| Jev answers drift under adversarial passages | The injection Noul is one filter, the routing is defence in depth, and phase 4's system-prompt guidance declares every passage untrusted |
| Per-pair fan-out exhausts the request budget | Pool of four, SHA-1 cache with deduplication, and usage counters exposed for observation |
| A rate limit or a failed pair wastes the batch | Every pair is contained: a failed, timed-out, or 429 pair is recorded in `failed` and excluded, the rest still grade, and the next dispatch waits on `RateLimitError.retryAfterMs` |
| A module-level cache outlives the lock it should not survive | No module default exists; the cache is passed in `options.cache`, owned by the port, generation-stamped like `src/ai/client-cache.ts`, and cleared from the same session lifecycle hook as the vector index |
| A slow or hung call stalls retrieval | Explicit 60s timeout, `AbortSignal` forwarded to every request, and the vendored `maxRetries: 2` bounded |
| Debug logging leaks decrypted passages | `logLevel` stays `warn`; the existing test asserting a spy logger never receives bodies stays green |
| Non-English judgments are weaker than English | Calibrate on the user's documents, surface confidence in the tool output, and document the caveat in the tool guide |

## Security Considerations

Every passage is untrusted input. The injection Noul reduces what reaches the prompt but is
not a boundary, and the module must not present it as one. A withheld passage is reported by
reason code, the route decision, and counts; the raw withheld payload is never echoed into a
tool result or a prompt, because echoing it would hand the model exactly the text the filter
removed. A length or a hash of the withheld span is acceptable if a caller needs a handle on
it; the text is not, and phase 4/5 assert the passage is absent. The module never generates
prose. Cached values are numeric judgments and hashes, never passage text, and the cache is
passed in and cleared by its owner, so a lock can drop it. The TypeSafe key stays in browser
memory, is never bundled, and is passed explicitly to the client.

## Next Steps

Phase 4 exposes these functions through four read-only harness tools, resolves the
thresholds and pool size from `rag` settings once per session, creates the per-session
`JevCache` that is passed to every call, and owns the one `createTypeSafe(settings,
{ timeoutMs: SYSTEM_ONE_TIMEOUT_MS })` construction site so judgments are discarded with
the session.
