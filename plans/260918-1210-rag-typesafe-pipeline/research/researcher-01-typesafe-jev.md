# TypeSafe System One / Jev API — research for the agentic RAG pipeline

**Task:** establish the exact, version-accurate TypeSafe surface for the `sagent-studio` agentic RAG feature: client-side encrypted document library, LLM drives retrieval tools, Jev supplies judgments (gate, rerank, query reformulation, citation verification).
**Installed SDK:** `@typesafe-ai/sdk@0.6.0` (`package.json:23`, `node_modules/@typesafe-ai/sdk/dist/index.mjs:390`).
**Read-only on app source.** One artifact written: this file.
**Date of research:** 2026-09-22.

## Sources and credibility

| Source | Type | Weight |
|---|---|---|
| `https://docs.typesafe.ai/llms.txt` + `/concepts/*`, `/primitives/*`, `/patterns/*`, `/cookbooks/*`, `/api`, `/models`, `/sdk/javascript` | Official vendor docs, `.md` variants | Primary |
| `node_modules/@typesafe-ai/sdk/dist/index.d.mts`, `index.mjs` (published dist of SDK 0.6.0) | Shipped artifact = ground truth for exact signatures | Primary for API shape |
| `/cookbooks/rerank_typesafe`, `/cookbooks/citation_check`, `/cookbooks/classifying_rag_passages`, `/cookbooks/parallel_questions`, `/cookbooks/semantic_find` | Official runnable cookbooks with published numbers | Primary, but cookbook numbers are pinned to `jev-1.12` and 2026-08/09 datetimes |
| `/model-jaggedness/jev-1.13` | Vendor self-reported limitations | Primary for caveats |

The docs are the source of truth and were reachable. Two documentation inconsistencies are recorded below rather than silently reconciled. Cookbook code samples are Python; the SDK section was verified against the installed TypeScript dist, not against the Python shape.

---

## 1. Headline answer

**Send one `systemOne` request per state, and put every question that uses that state into the same `questions` map.** Questions in one request are evaluated independently and in parallel, see the same state, and cost only their own extra tokens. There is no batch endpoint and no multi-state request.

For our pipeline this decomposes cleanly into four call sites:

1. **Query reformulation / gating** — one request, state = conversation + query, several Noul/Choice questions.
2. **Passage gating** — one request **per (query, passage) pair**, carrying all four per-passage questions.
3. **Rerank** — one request per (query, candidate) pair, one Noul, sort by the noul in code (this is exactly the documented rerank cookbook).
4. **Citation verification** — one request per (claim, source section) pair, with a cheap exact string match before it (this is exactly the documented citation-check cookbook).

All thresholds, sorting, normalization, and control flow stay in our code. Jev is not a calculator, a counter, a date comparator, or a generator.

---

## 2. Exact SDK call for multiple independent questions over one state

The public method is `TypeSafeClient.systemOne(request, options?)`:

```ts
systemOne<const Q extends Questions>(request: SystemOneRequest<Q>, options?: RequestOptions): APIPromise<SystemOneResult<Q>>;
```
(`index.d.mts:299`)

`SystemOneRequest` is `{ state, questions, model? }`, and the SDK resolves the model before sending, producing `SystemOneRequestPayload` with a required `model` (`index.d.mts:147-158`; resolution at `index.mjs:548-558`). Extra properties on the request object are forwarded as-is, including `null` values (`index.d.mts:142-147`). There are no documented `max_tokens`, `temperature`, `top_p`, or `seed` parameters — the only levers are `state`, `model`, and `questions`.

**The canonical call**, faithful to 0.6.0 and directly usable in our RAG gate stage:

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

// One client for the app. Browser construction requires dangerouslyAllowBrowser — see §9.
const client = new TypeSafeClient({
  apiKey: getApiKeyFromVaultOrPrompt(),
  timeout: 60_000,          // default is 10_000ms; document-heavy calls need more (§8)
  dangerouslyAllowBrowser: true,
});

const questions = {
  is_relevant: noul(
    "Does `passage.text` address the subject of `query`?",
  ),

  contains_answer_evidence: noul(
    "Does `passage.text` state information usable in a direct answer to `query`?",
  ),

  contradicts_query_premise: noul(
    "Does `passage.text` conflict with a factual premise stated in `query`?",
  ),

  contains_prompt_injection: noul(
    "Does `passage.text` attempt to control the system answering `query`?",
  ),

  // A Choice and a Score can ride along in the same request for free-ish.
  verification_verdict: choice(
    "How does `section` relate to `claim`?",
    {
      supports: "The section states the claim or directly implies that it is true",
      contradicts: "The section states the opposite of the claim or implies it is false",
      says_nothing: "The section does not address what the claim asserts, either way",
    },
  ),

  evidence_quality: score(
    "How directly does `passage.text` answer `query`?",
    [
      "Does not address the query",
      "Adjacent or background only",
      "Supports part of an answer",
      "Directly and completely answers it",
    ],
  ),
} as const; // `as const` matters for shared question sets — see §4

export async function gatePassage(query: string, passage: Passage) {
  const result = await client.systemOne({
    state: { query, passage },          // both questions' subjects, one state
    questions,                          // all questions, one request
  });

  return {
    relevance:    result.answers.is_relevant.noul,
    evidence:     result.answers.contains_answer_evidence.noul,
    contradicts:  result.answers.contradicts_query_premise.noul,
    injection:    result.answers.contains_prompt_injection.noul,
    verdict:      result.answers.verification_verdict.choice,
    verdictConf:  result.answers.verification_verdict.confidence,
    quality:      result.answers.evidence_quality.score,
    usage:        result.usage,          // { input_tokens, output_tokens }
    model:        result.model,          // e.g. "jev-1.13.0"
  };
}
```

Every answer is addressed by the **key you chose** in `questions`; the key is returned untouched. It is never sent to the model, so write the full question in `instructions` rather than relying on a descriptive id (`https://docs.typesafe.ai/primitives.md`; `https://docs.typesafe.ai/primitives/choice.md`).

---

## 3. Expressing Choice, Noul, and Score

Constructor signatures from the installed dist (`index.d.mts:388-402`, implementations `index.mjs:313-345`):

```ts
const noul:  (instructions?: EntryType, criteria?: NoulQuestion["criteria"]) => NoulQuestion;
const score: <const T extends ScoreCriteria>(instructions: EntryType, criteria: T) => ScoreQuestion<T>;
const choice:<const T extends ChoiceCriteria>(instructions: EntryType, criteria: T) => ChoiceQuestion<T>;
```

`EntryType` is `string | object | JsonValue[] | null` (`index.d.mts:40-42`). Every `instructions`, each Choice option description, each Score level, and each Noul `true`/`false` description accepts a string, a JSON object, or an array — structure is a first-class feature, not a hack (`https://docs.typesafe.ai/primitives/advanced.md`).

### Choice — "which of these?"

```ts
choice("Which team should handle this?", {
  billing:   "Charges, invoices, refunds, or subscriptions",
  technical: { what: "Bugs, outages, integrations", not_for: "Billing or account access", examples: ["500 errors"] },
  other:     null,   // null leaves the label undescribed; the label itself is still sent
})
```

- `criteria`: a map of `label → description`, **not an array**; the constructor throws if you pass an array (`index.mjs:338-345`).
- Wire format allows **up to 255 options** per Choice (`https://docs.typesafe.ai/api.md`; also stated on Choice and in `semantic_find`). The 255 limit is the binding constraint for "score every line id in one request".
- Response: `{ type: "choice", choice, confidence, probabilities }` (`index.d.mts:93-101`).

### Noul — "probability of yes"

```ts
noul("Does `passage.text` address the subject of `query`?")

// With an explicit yes/no boundary, which the docs recommend when the boundary is subtle:
noul("Has the customer contacted support about this before?", {
  true:  "Mentions a prior attempt, ticket, or that they have asked before",
  false: "No sign of any previous contact",
})
```

- `criteria` is optional `{ true?, false? }` (`index.d.mts:46-57`).
- Response: `{ type: "noul", noul }` — a single number 0..1 with **no separate `confidence`**. Choice/Score spread probability over options; a Noul has two outcomes so one number describes it completely (`https://docs.typesafe.ai/primitives/noul.md`).
- Phrase so that a high value means yes. A statement works as well as a question ("The customer is requesting a refund"). Do not invent a Noul where you want a degree — a Noul of 0.5 means "yes and no equally likely", not "medium" (`primitives.md`, `noul.md`).
- One condition per Noul. "Angry and asking for a refund" must be two Nouls combined in code (`noul.md`).

### Score — "degree along described levels"

```ts
score("How severe is the reported issue?", [
  "Cosmetic; no impact to functionality",
  "Broken or degraded feature, but workaround exists",
  "Blocking issue; no workaround exists",
])
```

- `criteria`: an **ordered array**, minimum 2, **maximum 10 levels**; the constructor throws on a non-array and `systemOne` throws if `length < 2` (`index.mjs:324-331`, `index.mjs:346-353`; limit from `https://docs.typesafe.ai/api.md`).
- `score` is the probability-weighted mean of level numbers and **can fall between levels** (e.g. 1.43). `legend` maps the level number back to its description; `probabilities` is keyed by level number as a string (`index.d.mts:102-117`).
- Response: `{ type: "score", score, confidence, legend, probabilities }`.
- Levels must describe **situations**, not degrees. "Moderately severe" gives the model nothing to match; each level is judged on its own and the model never sees neighbours or level numbers (`https://docs.typesafe.ai/primitives/score.md`).
- Keep one dimension per Score. Multi-dimensional descriptions lower confidence and devalue the score.
- `score` is weak for numeric calibration: do not interpolate between levels to reconstruct a number (`https://docs.typesafe.ai/model-jaggedness/jev-1.13.md`).

---

## 4. Answers, addressing by id, and confidence

`ResultFor<T>` maps each question type to its answer type, preserving the literal criteria keys:

```ts
type ResultFor<T extends Question> =
  T extends NoulQuestion ? NoulResponse :
  T extends ScoreQuestion<infer S> ? ScoreResponse<S> :
  T extends ChoiceQuestion<infer E> ? ChoiceResponse<E> : never;
```
(`index.d.mts:119`)

`SystemOneResult<Q>` is `{ model: string; answers: { [K in keyof Q]: ResultFor<Q[K]> }; usage: Usage }` (`index.d.mts:128-135`). Usage is `{ input_tokens, output_tokens }` (`index.d.mts:121-126`).

In practice you address answers by property, and TypeScript narrows each one:

```ts
const r = await client.systemOne({ state, questions });

r.answers.is_relevant.noul;                    // number
r.answers.verification_verdict.choice;         // "supports" | "contradicts" | "says_nothing"
r.answers.verification_verdict.confidence;     // number
r.answers.evidence_quality.score;              // number
r.answers.evidence_quality.legend["0"];        // the level-0 description

// Programmatic lookup when the id is dynamic:
const id = "is_relevant" as const;
r.answers[id].noul;
```

**Practical typing note (verified against the dist, not documented):** the `const` type parameters on `choice`/`score` only preserve literal criteria keys when the question object is passed inline or declared with `as const`. A plain `const questions = { ... }` widens Score `criteria` to `string[]`, which no longer satisfies `ScoreCriteria` (a tuple of at least two). Declare shared question sets `as const` (as in §2) or pass them inline. If you ever need explicit types, `type Answers = SystemOneResult<typeof questions>["answers"]` and `ResultFor<typeof questions.is_relevant>` both work.

### What `confidence` is

- It is a **statistic computed from the answer's own `probabilities` distribution**: concentrated on one outcome → near 1.0; spread out → low. TypeSafe returns it on every Choice and Score answer; **Noul answers do not carry one** (`https://docs.typesafe.ai/confidence.md`, `index.d.mts:87-117`).
- The exact server-side formula is **not published**. The docs' interactive demo shows the approximation `(3 × largest probability − 1) / 2` for a three-option Choice, and explicitly says you are not locked into their definition because the full `probabilities` are returned and you may compute your own measure (`confidence.md`). Treat `confidence` as a convenience, and reach for `probabilities` when you need precision (e.g. the docs' own approach of thresholding `max(probabilities.values())` in the parallel-questions cookbook).
- **Caveats, stated by the vendor:**
  - "This describes the model's answer, not a guarantee that the answer is correct." (Score page, on confidence 1.0.)
  - Different distributions can produce the same Score: 1.0 can mean all mass on level 1, or half on levels 0 and 2. Read `probabilities` and `confidence` alongside `score`.
  - Low confidence on a Score usually means one of three things: levels overlap for this state, the question measures more than one thing, or the state lacks enough information (`score.md`).
  - Structural invariants are **not** guaranteed. A Noul and a yes/no Choice on the same proposition disagree (example given: Noul 0.22 vs Choice `no` 0.99). A question and its negation do not sum to 1 (example: `refund` 0.72 + `not_refund` 0.47 = 1.19). Do not carry a threshold calibrated on a Noul onto a Choice, and do not rely on cross-question identities (`jev-1.13.md`).

---

## 5. Splitting vs combining; token/cost/latency; batching passages

### Split, then combine in code

The strongest repeated instruction in the docs: **decompose into atomic questions and combine in code.** "Broad questions hide several judgments behind one answer. Atomic questions expose those judgments so you can inspect, tune, and combine them in code." (`https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md`). The `how-to-build` page shows a one-Noul "Is this spam?" replaced by six atomic Nouls, and a one-Noul tool-trace check replaced by nine.

Composite scoring is the canonical pattern: one Score per dimension, normalize each to 0–1 by dividing by `levels - 1`, then weight in code. Weights live in code so you can see and change the composition without rewording a prompt (`https://docs.typesafe.ai/patterns/composite-scoring.md`, `score.md`).

Two independent questions in one request cost only the extra question tokens; the state is sent once. Questions are evaluated in parallel. **Ask a question you might not need — it is close to free, and code ignores the answer** (Speculative fan-out, `https://docs.typesafe.ai/patterns/fan-out.md`).

### When a question genuinely depends on a prior answer

Questions in one request are independent: one answer never becomes context for another. Only make a second request when your code **cannot build the second request until it has the first answer** — because it must fetch more state, decide what the state is made of, or choose the next question's options. "Two requests are the exception, not the rule." Documented legitimate second-request cases: skill suggestion (rank 182, then fetch top-3 text and re-judge), autoformat (classify blocks that did not exist until step 1), hierarchical classification (each Choice decides the next level's options) (`primitives.md`).

For our pipeline: reformulation → retrieval is a *real* second request, because the retrieved passages do not exist until the reformulated query is searched. Passage gating and citation checks are not.

### Cost and latency, with numbers

The parallel-questions cookbook runs a 13-question regulatory briefing over a ~54,000-character document, 5 repeats each way:

| Strategy | Calls | Cost | Total time |
|---|---|---|---|
| One call, all 13 questions | 1 | $0.000497 | 0.27s |
| 13 calls, one question each | 13 | $0.006090 | 2.71s |

Reported saving: **12.2× cheaper and 10.0× faster** (`https://docs.typesafe.ai/cookbooks/parallel_questions.md`). The answers were identical: 11 of 13 questions had std dev exactly 0.0 under both strategies, and the two noisy Nouls had the same noise under both, i.e. batching adds neither bias nor variance.

**Documentation discrepancy to record:** the primitives page states the same cookbook result as "11.5x cheaper and 9.6x faster" (`primitives.md`). The cookbook itself prints 12.2×/10.0×. The direction is unambiguous; the exact multiplier is not stable across doc revisions.

The mechanism is simple: the document dominates every request, so N single-question calls re-send it N times. "The bigger the document, the nearer that saving comes to a full Nx." Adding questions barely changes response time.

### Can a request batch passages?

**Two documented answers, and the distinction matters for us.**

**(a) One pair per request (the rerank and RAG-classification cookbook default).** State is `{query, candidate}`, one request per candidate. The classifying-RAG-passages cookbook is explicit and quotes directly:

> "One request per passage, so cost scales with `k`. Nothing batches passages into one request, because each question is about one pair."

(`https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md`). The rerank cookbook does the same and says "A real application would ask several questions about the same pair in one call", pointing at parallel questions / fan-out for that — i.e. batch *questions per pair*, not passages per request (`https://docs.typesafe.ai/cookbooks/rerank_typesafe.md`).

**(b) Many indexed items in one state, one question per item (documented, and used in production cookbooks).** `semantic_find` tags 218 lines with ids, sends the whole tagged document as one state (~44k characters), and scores all 218 line ids with **one Choice question whose 255 options are the line ids**, plus a Noul existence check — all in one request. The 255-option cap is then the practical document-size limit for that recipe, and past it the docs say to do two passes (`https://docs.typesafe.ai/cookbooks/semantic_find.md`). The Noul "structured instructions" example generalizes this: build one question per candidate record in code, all in one request, with the record embedded in `instructions` (`primitives/noul.md`). The jaggedness page also endorses using a Noul to filter for relevance when filtering state in code is impossible (`jev-1.13.md`).

**Trade-off.** Option (b) pays for the state once and saves round-trips, but it makes the state large, and the vendor warns that "Accuracy falls as the state grows with content unrelated to the decision... Jev suffers from context rot" (`jev-1.13.md`). Option (a) keeps each state small and focused, which is the vendor's own advice to "retrieve and filter in code first, and send only the fields the question needs", at the cost of re-sending the query N times and hitting the rate limit with N requests.

### Ranked recommendation for our retrieval fan-out

1. **Per-pair requests (option a), with bounded concurrency (4–8 workers), for passage gating and rerank.** This is the documented RAG pattern, keeps states small, and is what the cookbooks actually run. The RAG cookbook's own pool is `max_workers=4` with the comment: "Keep the pool small: the public endpoint rate-limits." The rerank cookbook used `max_workers=12` for 1,200 calls. Pick 4 unless we are on an enterprise plan.
2. **One-state-many-questions (option b) only for line-id search inside a single short document** (≤255 options, state comfortably within 32k tokens). Use `semantic_find`'s two-pass fallback beyond 255.
3. **Never** put many passages in one state and ask one broad "which is best?" Noul/Score. Counting and multi-hop comparisons inside a single question are exactly the documented failure modes.

---

## 6. How the RAG cookbooks decompose their steps

### 6.1 Rerank (`/cookbooks/rerank_typesafe`)

**Pipeline:** BM25 fast search → 30-candidate shortlist per query → one TypeSafe Noul per query-candidate pair → sort in code by the noul.

**The question, verbatim (the structured criteria are the load-bearing part):**

```python
is_cited_source = Noul(
    instructions=(
        "The query excerpt comes from a US federal court opinion and was written "
        "immediately around a citation to a precedent; the citation itself has been "
        "removed. Could the candidate passage be from that cited precedent — does it "
        "establish the specific legal proposition the query excerpt invokes at its "
        "citation point?"
    ),
    criteria=NoulCriteria(
        true=(
            "The candidate passage states or establishes the specific rule, standard, "
            "holding, or fact pattern that the query excerpt attributes to its removed "
            "citation."
        ),
        false=(
            "The candidate passage is merely on a similar topic or doctrine; it does not "
            "supply the specific proposition the query excerpt relies on."
        ),
    ),
)
```

**Routing/combination in code:** there is no threshold at all. "The question's criteria define what counts as true and false... That noul is the score the application sorts on." The code is `sorted(shortlist, key=lambda c: -nouls[c])`.

**Results and cost:** top-1 5% → 18%, top-5 15% → 35%, top-10 38% → 62%. 1,200 calls, 1,536,002 input tokens and 25,200 output tokens, **$0.0645** total at `jev-1.12` pricing ($0.042/Mtok input, output free). Model pinned to `jev-1.12`, `timeout=120.0`.

**Transferable lesson for us:** for rerank, return the raw noul and sort — do not threshold. Reserve thresholds for gate decisions. The Noul `true`/`false` criteria are what make 30 independent pairwise judgments comparable; a bare yes/no question would not be.

### 6.2 Citation check (`/cookbooks/citation_check`)

**Pipeline:** exact normalized string match → if the quote is absent, mark `fabricated` with no model call → otherwise one Choice question on the matched section → confidence gate.

**Step 1, deterministic:** normalize whitespace and curly quotes, then substring-match the quote against numbered sections. A miss is `fabricated` with `confidence: null` and `auto: true` — no model involved.

**Step 2, the Choice question, verbatim:**

```python
QUESTIONS = {
    "relation": Choice(
        instructions="How does the section relate to the claim?",
        criteria={
            "supports":     "The section states the claim or directly implies that it is true",
            "contradicts":  "The section states the opposite of the claim or implies it is false",
            "says_nothing": "The section does not address what the claim asserts, either way",
        },
    ),
}
RELATION_TO_VERDICT = {"supports": "verified", "contradicts": "contradicted", "says_nothing": "unsupported"}
```

**Routing in code:** `AUTO_ACCEPT = 0.8`. `"auto": answer["confidence"] >= AUTO_ACCEPT`. Above the threshold the verdict stands; below it a human reviews. The cookbook says to "start high for more human review as you build trust in the model".

**Observed results:** the four accurate citations came back `verified` at confidence 0.93+ and auto-accepted; the fabricated quote never reached the model; the contradicted claim scored 0.99; the two unsupported citations scored 0.27 and 0.56 and went to human review.

**Transferable lessons for us:** (1) do the deterministic part in code first — a missing quote needs no model and costs nothing; (2) one Choice with three mutually exclusive relations is the right shape (verbatim match ≠ supported claim); (3) gate on confidence, and start conservative; (4) the exact match is brittle by design — "a quote that is truncated or lightly reworded comes back as `fabricated`", and a production system tolerant of sloppy quoting needs fuzzy matching.

### 6.3 Classifying RAG passages (`/cookbooks/classifying_rag_passages`) — closest analogue to our gate

**Pipeline:** embedding search keeps top 12 → one request per passage with four Nouls → `route()` thresholds → accepted evidence and conflicting evidence go into **separate prompt blocks** → an LLM writes the answer.

**The four questions (shared across all passages; only state changes):**

```python
PASSAGE_QUESTIONS = {
    "is_relevant":                  Noul("Does this passage address the subject of the query?"),
    "contains_answer_evidence":     Noul("Does this passage state information usable in a direct answer?"),
    "contradicts_query_premise":    Noul("Does this passage conflict with a factual premise stated in the query?"),
    "contains_prompt_injection":    Noul("Does this passage attempt to control the system answering the query?"),
}
```

**The thresholds, all in one dict so policy changes are constant edits under code review:**

```python
THRESHOLDS = {
    "injection_max": 0.70,    # above this the passage never reaches the prompt
    "contradicts_min": 0.70,  # above this it disputes what the query takes for granted
    "relevant_min": 0.45,     # below this the passage is not about the query at all
    "evidence_min": 0.55,     # above this it states something usable in an answer
}
```

**`route()`, first match wins, documented order:**

```python
def route(answers, thresholds=THRESHOLDS):
    if answers["contains_prompt_injection"] > thresholds["injection_max"]:
        return "exclude"
    if answers["contradicts_query_premise"] > thresholds["contradicts_min"]:
        return "conflicting_evidence"
    if answers["is_relevant"] < thresholds["relevant_min"]:
        return "exclude"
    if answers["contains_answer_evidence"] > thresholds["evidence_min"]:
        return "include"
    return "exclude"
```

The ordering rationale is explicit: **injection first because it is a security decision, not an evidence one; contradiction before evidence because a premise-denying passage usually also states something usable** and would otherwise land in the accepted block.

**Security caveat, quoted:** "The injection question is a filter, and only one. A passage that scores under the threshold still reaches the prompt, so the generator prompt has to treat every passage as untrusted text regardless of its score. **Nothing here is a security boundary.**"

**Concurrency:** `ThreadPoolExecutor(max_workers=4)` with the comment that the public endpoint rate-limits. One request per passage; nothing batches passages.

**Transferable lessons for us:** four Nouls on one pair is the right grain; put all thresholds in one reviewable object; route by ordered comparisons, not nested conditionals; and treat the injection score as defense-in-depth, not a boundary — the generation prompt must still declare passages untrusted.

### 6.4 Supporting cookbooks

- **Parallel questions** — the batching economics above.
- **Line-by-line search (`semantic_find`)** — 218 line ids as Choice options in one request plus a Noul existence check; `FOUND, ABSENT = 0.7, 0.35` with a middle `"partially addressed"` verdict. Key insight: "Choice probabilities always add up to 1, so a line ranks first even when none answer the query" — the Choice ranks, the Noul decides whether an answer exists at all. Directly applicable to our "does the corpus contain an answer?" gate.
- **Guardrails, SDE cascade, autoformat, hierarchical classification, entity alignment, consistency** — not read in depth; they are lower-relevance variants of the same decompose-then-compose discipline. Flagged as not covered in §11.

---

## 7. Confidence-based routing and calibration caveats

**Three bands, and thresholds scale with risk** (`https://docs.typesafe.ai/confidence.md`, `https://docs.typesafe.ai/patterns/confidence-routing.md`):

- High confidence → act automatically.
- Medium confidence → proceed with caution: confirm, flag for review, or gather more information.
- Low confidence → do not act: route to a human, ask for clarification, or fall back.

The docs' worked example uses a **0.6 floor** below which any action routes to support, then **0.85** for a high-stakes operation (`approve_transfer`), while a read-only action (`check_balance`) is fine at 0.6. "The 0.5 confidence floor catches anything the model reports as genuinely uncertain" in the other example.

For Nouls, the same three-way split is expressed with two thresholds. The Noul page uses `YES = 0.8`, `NO = 0.2`, and sends values strictly between them to a human. Threshold guidance: use 0.5 when yes and no are equally easy to act on; **raise it when acting on a false yes is expensive** (paging someone, issuing a refund); **lower it when missing a true yes is expensive** (failing to flag a safety issue).

**Representative thresholds across the docs**, which is useful for calibrating our own defaults:

| Context | Threshold | Source |
|---|---|---|
| Citation verdict auto-accept | 0.8 | citation_check |
| RAG passage injection / contradiction | 0.70 | classifying_rag_passages |
| RAG passage evidence | 0.55 | classifying_rag_passages |
| RAG passage relevance floor | 0.45 | classifying_rag_passages |
| Document-answer-exists found / absent | 0.7 / 0.35 | semantic_find |
| Rerank | none — sort by noul | rerank_typesafe |
| Noul three-way band | 0.8 / 0.2 | noul.md |
| Confidence floor / high stakes | 0.6 / 0.85 | confidence-routing.md |

Every one of these is described as a **starting point, not a default**: "We picked these four numbers for this corpus. Treat them as a starting point, not defaults." A change of policy should be a constant edit, not a reworded question. The docs also suggest plotting confidence against accuracy on your own data to test thresholds, and note that confidence is only a convenience — you always have `probabilities` to build a better measure.

**Calibration caveats to carry into the design:**
- Confidence describes the model's answer, not its correctness (explicit on the Score page).
- Jev is trained with RLCD to give calibrated probabilities "instead of tending toward overconfidence" (`how-to-build-with-system-one.md`), but the jaggedness page shows concrete cases where it is wrong or literal.
- Adversarial content can move the answer: "State is data, and `jev-1.13` does not treat it as hostile by default." Our document library is, by construction, untrusted input — this is a first-class risk, not a footnote.
- The model is self-consistent (similar inputs give similar outputs) but not structurally invariant; see §4.
- For our browser app, a mis-gate is a user-visible wrong answer. Given the vendor's own advice to start conservative, begin with the citation-check posture (high auto-accept threshold) and loosen with measured data.

---

## 8. Errors, retries, rate limits, and documented limits

### Error classes and HTTP mapping

`TypeSafeError` is the base; `APIError` extends it and carries `status`, `headers`, `body`, `requestId` (`index.d.mts:326-344`). Subclasses map one-to-one to statuses (`index.mjs:190-199`):

| Status | Class | When |
|---|---|---|
| 400 | `BadRequestError` | Invalid request |
| 401 | `AuthenticationError` | Missing/invalid key |
| 403 | `PermissionDeniedError` | Access denied |
| 404 | `NotFoundError` | Resource not found |
| 422 | `UnprocessableEntityError` | Body failed validation; body details the field |
| 429 | `RateLimitError` | Rate limit exceeded; exposes `retryAfterMs` (`index.d.mts:356-358`) |
| 5xx | `InternalServerError` | Server failure |
| — | `APIConnectionError` | DNS/TLS/connection/interrupted body |
| — | `APITimeoutError extends APIConnectionError` | Full response did not arrive within `timeoutMs` |
| — | `APIUserAbortError` | Caller aborted via `AbortSignal` |

The HTTP API table additionally documents **`529 Overloaded`** and says to back off and retry (`https://docs.typesafe.ai/api.md`). Note that `529` is not mapped to a named class in 0.6.0; it falls through `fromResponse` to a plain `APIError` with `status: 529`. It is still retryable because the default retry set is "408, 429, and 500–599" (`index.mjs:79-83`), which includes 529.

Locally thrown `TypeSafeError`s (before any network call): missing API key (`index.mjs:391-393`), no global `fetch` (`index.mjs:394-396`), browser refusal (`index.mjs:397-399`), invalid config values, **empty `questions` map**, and **Score with fewer than two criteria** (`index.mjs:346-353`). Choice-criteria-as-array and Score-criteria-as-map also throw in the constructors (`index.mjs:325`, `index.mjs:339`).

### Retry policy, verified defaults

From `index.mjs:72-89` and mirrored in `index.d.mts:159-179`:

```ts
{
  maxRetries: 2,            // retries AFTER the initial attempt
  backoffInitialMs: 500,
  backoffMaxMs: 5000,
  backoffJitter: 0.25,      // fraction randomly subtracted
  httpStatuses: {408, 429, 500..599},
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  apiConnectionError: true,
  apiTimeoutError: true,
}
```

- `retry-after-ms` is preferred over `Retry-After`; a numeric `Retry-After` is seconds, otherwise it is parsed as an HTTP date (`index.mjs:98-107`). A server delay longer than `maxRetryAfterMs` falls back to capped exponential backoff (`index.mjs:113-119`).
- **The timeout is per attempt, and there is no total retry budget** (`index.d.mts:184-185`, `index.mjs:628-662`). Default `timeout` is **10,000ms** per attempt (`index.d.mts:220`, `index.mjs:518`). With `maxRetries: 2` that is up to three attempts. Abort is via `RequestOptions.signal` and cancels pending retries too.
- Retries are logged at `info`; `X-TypeSafe-Retry-Count` is sent on retries (`index.mjs:591-595`). Log level defaults to `warn`; `debug` logs headers and bodies with known credential headers redacted — **but bodies are not redacted** (`index.d.mts:210-215`). Do not ship `debug` logging in the browser: request bodies will contain decrypted document text.

**Recommendation for us:** raise `timeout` for document-heavy calls (the cookbooks use `timeout=120.0`), pass an `AbortSignal` so a cancelled retrieval aborts in-flight Jev calls, and treat `RateLimitError.retryAfterMs` as the source of truth for our own concurrency throttle.

### Documented limits

| Limit | Value | Source |
|---|---|---|
| Context per request | **64k tokens** (state + all questions) | models.md |
| State + single longest question | **32k tokens** | models.md |
| Choice options | **255** | api.md, choice.md, semantic_find |
| Score levels | **2–10** | api.md, score.md |
| Input modality | Text only (string, JSON object, or array of text). No image/audio/video | models.md, state.md |
| Price (`jev-1.13.0`) | **$0.042 per Mtok input; output tokens free** | models.md |
| Rate limit | **250,000 tokens/second and 1,200 requests/minute** | models.md |
| Retry-after honoring | up to 60s server delay | index.mjs:86 |

**Rate limits are explicitly dynamic:** "the limits above can change without notice"; a request over either limit returns 429; higher limits are enterprise-only (`models.md`). The per-minute request cap is the binding constraint for our fan-out, not the token rate. At 12 passages/query with `max_workers=4`, a moderate burst stays well inside 1,200 rpm, but a bulk re-index of the document library would not — that work must be chunked and throttled with client-side backoff.

**Model ids and aliases:** `jev-latest` and `jev-preview` both currently resolve to `jev-1.13.0`. The SDK default is `jev-latest` when neither `model` nor `TYPESAFE_DEFAULT_MODEL` is set (`index.mjs:514`). The response's `model` field reports the **versioned** id that answered, so log it. The docs warn that an alias moves without our action, and that if we tune confidence thresholds against a version we should **pin the versioned id**. For a reproducibility-sensitive pipeline, pin `jev-1.13.0`.

---

## 9. Browser usage and API key security

This is the highest-risk area for `sagent-studio`, and the SDK is opinionated about it.

**The SDK refuses to construct in a browser by default.** The constructor calls:

```ts
if (isBrowser() && !config.dangerouslyAllowBrowser) refuseBrowser();
```
(`index.mjs:511`), where `isBrowser()` requires `window`, `window.document`, and `navigator` (`index.mjs:376`), and `refuseBrowser` throws:

> "TypeSafeClient is running in a browser, which would expose your API key to anyone using the page. Call the API from a server instead, or pass `dangerouslyAllowBrowser: true` if you understand the risk."
> (`index.mjs:397-399`)

The config field is documented as: "Allow browser use, exposing the API key to page users. **Default: false**." (`index.d.mts:225`). The JS SDK page and quickstart do not mention browser use at all; the only browser guidance in the SDK is the refusal message and the config comment.

**Architectural fit with our app.** Our `vite.config.ts` already documents the intended posture: "Keys live in browser memory, so script injection is the primary threat and `script-src 'self'` is the containment control that must not be relaxed" (`vite.config.ts:8-31`). Its CSP already permits `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (line 47), so a direct call to `https://api.typesafe.ai` is reachable without a CSP change. The app is a local-first harness where the key belongs to the user, not to a hosted multi-tenant service — so `dangerouslyAllowBrowser: true` is defensible here in a way it would not be for a public web app. The SDK already sets `X-TypeSafe-Runtime: browser` (`index.mjs:378-386, 585`), so the vendor can see browser traffic.

**Hard rules for our implementation:**

1. **Never build the key into the bundle.** Vite inlines `VITE_*` variables at build time; a `VITE_TYPESAFE_API_KEY` would be readable in the shipped JS. The key must be user-supplied at runtime (from the app's vault or an explicit settings prompt) and held in memory, matching the app's existing "keys live in browser memory" model.
2. **Pass it explicitly** to `new TypeSafeClient({ apiKey, dangerouslyAllowBrowser: true })`. Do not rely on `process.env.TYPESAFE_API_KEY`: `readEnv` returns `undefined` when `process` is absent (`index.mjs:65-68`), so the env fallback is inert in the browser anyway.
3. **Do not enable `debug` logging in production.** Bodies are not redacted (`index.d.mts:210-215`) and our bodies are decrypted documents.
4. **The vendor's own security posture is explicit that TypeSafe is not a security boundary.** The RAG cookbook: "Nothing here is a security boundary." Prompt injection mitigation is defense-in-depth; the generation prompt must still treat every passage as untrusted text.
5. **A local proxy is the alternative** if we later want the key out of the page: a Vite `server.proxy` entry forwarding `/v1/typesafe` to `https://api.typesafe.ai` keeps the key server-side during development, but it only helps for the dev server and does not change the production posture for a local-first app.
6. **Data handling:** "Jev is not trained on customer requests or responses. See Legal for the Data Processing Agreement... and zero data retention (ZDR) for enterprise customers." (`models.md`). For an encrypted-document feature this needs a product decision — decrypted passages leave the device to reach Jev, which is inherent to using the API at all.

---

## 10. Multilingual limitations

Documented plainly and worth surfacing in the UI:

> "Jev accepts natural-language text. **English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev for a non-English workload, and pay close attention to Confidence when routing.**"
> (`https://docs.typesafe.ai/models.md#language-support`)

Restated on the state page: "Jev's primary training language is English; other languages, including CJK scripts, are accepted but currently have lower accuracy" (`https://docs.typesafe.ai/concepts/state.md`). There is no per-language accuracy figure and no list of "supported" languages. The documented mitigation is the same as everywhere else: route on confidence, and test on our own documents. For a document library that may hold non-English material, the gate must not silently apply English-calibrated thresholds; either surface confidence in the UI or fall back to a generative model for non-English verification.

---

## 11. Architectural fit and ranked recommendations

The pipeline maps onto the SDK with no adapter layer: one `TypeSafeClient`, one `systemOne` call per judgment site, all thresholds in code.

**Trade-off matrix for the fan-out strategy** (the one real design fork):

| Dimension | (a) One request per pair | (b) All passages in one state, one question per passage |
|---|---|---|
| Accuracy / context fit | **Best.** Small focused state; matches vendor advice to filter first. | Weaker. Large state causes context rot and distractors (jaggedness #5). |
| Input-token cost | Re-sends the query N times (query is small; passages are not). | Pays for the combined state once. |
| Latency | N requests; bounded concurrency gets most of the win. | One request. |
| Rate-limit pressure | Higher: N requests/min. Mitigated by concurrency cap and backoff. | Lower request count, higher token count. |
| Documented precedent | rerank (1,200 calls), classifying_rag_passages (1 per passage). | parallel_questions, semantic_find (218 options), fan-out. |
| Hard cap | Context per pair. | **255** options for a Choice; 32k state budget. |
| Code complexity | Low; a pool and a sort. | Low for line-id search; needs index-addressable questions otherwise. |

**Ranked choices:**

1. **Adopt option (a) — one request per (query, passage) pair — for gating and rerank**, using four Nouls per pair copied from the RAG cookbook's shapes and bounded concurrency (start at 4). This is the pattern with the strongest documented precedent for exactly our task, keeps Jev in its best operating regime (small, focused state), and maps directly onto the cookbook's `route()` logic.
2. **Use option (b) — one request, many indexed items — only for line-id search inside a single bounded document** (≤255 lines, state within 32k tokens), with the two-pass fallback beyond 255. Reuse `semantic_find`'s Choice-ranks / Noul-decides split, and its `0.7 / 0.35` found/absent band.
3. **Keep confidence gating conservative and centralized.** One module owns every threshold, mirroring `THRESHOLDS` in the cookbook, so re-tuning is a constant edit. Start at citation-check severity (0.8 auto-accept) and loosen with measured data.
4. **Pin `model: "jev-1.13.0"`** and log `result.model`, `result.usage`, and the request id from `APIPromise.withResponse()` (`index.d.mts:26`) for reproducibility and cost accounting. The rerank cookbook's real cost is directly measurable: ~$0.065 for 1,200 pair calls.
5. **Treat injection filtering as defense-in-depth only.** The generation prompt must always declare passages untrusted and instruct the model to ignore instructions inside them.
6. **Do not use Jev for arithmetic, counting, date comparison, or generation.** Thresholds, ranking, normalization, dedup, and citation string-matching stay in code. This is the single most repeated warning in the docs (`jev-1.13.md`).

---

## 12. Documented failure modes we must design around

From `https://docs.typesafe.ai/model-jaggedness/jev-1.13.md` (applies to `jev-1.13`; last reviewed 2026-09-17):

| # | Failure mode | Required design response |
|---|---|---|
| 1 | Literal reading — answers the words written, not the intent | State the exact condition; put boundary cases in criteria |
| 2 | Math and numbers — no reliable counting or arithmetic | Count and compute in code; ask one question per item |
| 3 | Date/time comparison — reads dates as text not ordered quantities | Extract parts with Choice; compare in code |
| 4 | Indirection — double negatives and multi-hop reasoning cost accuracy | One hop per question; point at the state by name |
| 5 | Large state with irrelevant detail — context rot | Retrieve and filter in code first; send only what the question needs |
| 6 | Adversarial content — state is not treated as hostile | Precision in criteria; assume untrusted documents; test edge cases |
| 7 | Contradictory instructions and criteria | Align instruction and criteria; high means yes |
| 8 | Common-sense structural invariants not guaranteed | Do not expect Noul/Choice agreement or negation sums to 1 |
| 9 | Generation — not a text generator | Never ask it to write prose; use a generative model |

Also relevant: "Avoid... Hiding several judgments inside one question... System Two tasks: more layers of indirection... Giving it more context in `state` than the question needs."

Jev is explicitly designed **not** to be an agent: "System One is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action." (`how-to-build-with-system-one.md`). Our design must therefore keep the agent loop in the LLM/tool layer and use Jev strictly as a leaf judgment — which is exactly how the RAG pipeline is scoped.

---

## 13. Limitations of this research

- **Not read in depth:** `pre_parsed_value_extraction_cookbook`, `autoformat`, `hierarchical_classification`, `function_calling`, `llm_guardrails`, `sde_cascade`, `entity_alignment`, `skill_suggestion`, `consistency_*`, `date_extraction`, `classification_using_confidence`, the machine-learning primer, the agent skill, and the full JS API reference pages for individual classes. Each is a variant of the same decompose/compose discipline and none appeared load-bearing for the specific questions asked; the ones that are (rerank, citation check, RAG passage classification, parallel questions, line-by-line search) were read in full.
- **Python-shaped cookbooks, TypeScript verified separately.** Cookbook code is Python and could not be executed. All TypeScript signatures, defaults, and error behavior were verified against the installed `@typesafe-ai/sdk@0.6.0` dist.
- **Cookbook numbers are historical.** Rerank and citation-check numbers come from `jev-1.12` at 2026-08 steps; the parallel-questions price is `$0.042/Mtok` as of 2026-09. They are directional, not current-model benchmarks.
- **No live API calls were made.** Everything is documentation plus dist inspection. Rate-limit behavior under our real fan-out is unmeasured.
- **The exact `confidence` formula is unknown.** Only a three-option approximation is published. If our thresholds depend on precise confidence semantics, we should measure the relationship between `confidence` and accuracy on our own documents.
- **The `dangerouslyAllowBrowser` decision is a product/security call, not a technical one.** This report states the SDK's behavior and the app's existing posture; it does not decide whether shipping a user-supplied key in page memory is acceptable for the product.
- **Cookbook code examples are not ours to reuse verbatim.** They assume Python SDK types (`NoulCriteria`) and Python concurrency; the TypeScript equivalents are given in §2 and §3.

## 14. Unresolved questions

1. **Concurrency and throttle policy.** What is our per-user request budget? The docs give 1,200 rpm account-wide and say limits are dynamic; we need our own limiter, and the right `max_workers` is unmeasured for our passage sizes.
2. **Passage size vs. the 32k state budget.** What is our maximum passage length, and does a query + passage + four questions with structured criteria reliably fit? Needs measurement with real documents.
3. **Whether to pin `jev-1.13.0` or track `jev-latest`.** Pinning protects tuned thresholds but freezes model improvements. Requires a product call on the update cadence.
4. **Non-English document policy.** Do we gate non-English documents differently, surface confidence in the UI, or fall back to a generative model for verification? The docs only say accuracy is lower and to watch confidence.
5. **Whether to compute our own confidence measure** from `probabilities` rather than using the returned `confidence`. The docs explicitly invite this but publish no cookbook for it.
6. **Cost ceilings for bulk operations.** A full-library gate/re-index fan-out scales with pairs; the rerank cookbook's ~$0.065/1,200 pairs is a useful anchor but our passages are longer.
7. **Prompt-injection handling beyond the Noul filter.** The vendor states TypeSafe is not a security boundary. The generation-prompt hardening and any post-filtering are our responsibility and are out of scope for this research.
