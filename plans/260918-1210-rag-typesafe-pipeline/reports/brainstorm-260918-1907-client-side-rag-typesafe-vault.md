---
title: Client-side RAG + TypeSafe judgments with encrypted local vault
date: 2026-09-18
status: accepted
scope: greenfield (sagent-studio)
---

# Brainstorm: Client-side RAG + TypeSafe enhancement + encrypted vault

## Summary

Feasibility confirmed: a fully client-side retrieval pipeline (document chunks,
embeddings, vector index) in IndexedDB is practical at the target scale
(hundreds of text/markdown files). TypeSafe System One models enhance the flow at
three checkpoints. Because both TypeSafe and the chosen LLM provider are remote
APIs, "fully client-side" holds for **retrieval and storage only**; the vault
(config + secrets + content + vectors) is encrypted at rest with a user password.

Greenfield state: no application code exists beyond the Vite template.

## Contract

**Outcome.** An app where the user unlocks a local vault with a password, configures
one or more LLM providers (custom base URL, key, model) and a TypeSafe key, ingests
text/markdown documents into an encrypted local index, and asks questions. An LLM
API drives an agent loop whose `search` tool performs client-side retrieval, gates
and re-ranks candidates with TypeSafe, and whose `verify_citation` tool checks the
answer against source chunks.

**Constraints.**
- Retrieval, embeddings, and storage stay on-device; no server component.
- Secrets, provider config, chunk text, and vectors are encrypted at rest.
- Password is required on every page open; unlock decrypts everything into memory.
- `TypeSafeClient` runs in the browser via `dangerouslyAllowBrowser: true`.
- TypeSafe and the LLM provider receive query text and document chunks over the network.
- All routing thresholds live in code, not in prompts.

**Non-goals.**
- Server-side proxy for API keys.
- Password recovery or recovery keys (hard vault: forgotten password means lost data).
- Multi-device sync, user accounts, sharing.
- ANN / approximate nearest neighbour index.
- TypeSafe as a text generator (it returns judgments only).
- Per-field encrypted querying inside Dexie.

**Acceptance criteria.**
1. Config and index persist across reload; wrong password reveals nothing.
2. Adding a custom provider (base URL + key + model) and a TypeSafe key lets chat run.
3. A false-premise query routes to `conflicting_evidence` and the LLM reports the
   conflict instead of fabricating an answer.
4. A passage carrying a hidden instruction is excluded before reaching the LLM.
5. A hallucinated or contradicted citation is flagged by `verify_citation`.
6. Number of passages entering the prompt drops measurably versus ungated retrieval.
7. Locking the vault clears key and vectors from memory.
8. Offline (no API reachable), retrieval still functions.

## Verified environment evidence

Inspected in the workspace, not assumed:

- `package.json`: Vite 8 + React 19 + TS 6, Tailwind 4, React Compiler.
- Installed and usable: `dexie@4` (IndexedDB), `ai@7` + `@ai-sdk/react` (agent loop
  and streaming), `@typesafe-ai/sdk@0.6.0`, `zustand`, `motion`, `radix-ui`.
- **No LLM provider package installed** (`node_modules/@ai-sdk` holds only `react`).
- `ai@7` exports `customProvider` and `createProviderRegistry`, so a
  user-configured base URL and model can be wired without per-vendor packages.
- `@typesafe-ai/sdk` exports `TypeSafeClient`, `choice`, `noul`, `score`
  (types: `Noul`, `Choice`, `Score` primitives).
- **No crypto dependency installed.** WebCrypto (`crypto.subtle`) provides PBKDF2 and
  AES-GCM natively.
- `@typesafe-ai/sdk` `TypeSafeClient` throws on construction in a browser unless
  `dangerouslyAllowBrowser: true` (verified at
  `node_modules/@typesafe-ai/sdk/dist/index.mjs:511`; the package publishes `dist/`
  only, so source reading targets the bundled ESM, not `src/client.ts`).
- TypeSafe docs guidance: `Keep API credentials server-side in web apps` — accepted
  risk for this local/personal app, to be surfaced in the UI.

## Approaches considered

### Retrieval / index layer

| Approach | Description | Fails first when |
| --- | --- | --- |
| **A. Dexie + transformers.js + brute-force cosine (chosen)** | `multilingual-e5-small` q8, 384 dims, typed-array scan | Corpus exceeds ~50k chunks or no WebGPU plus large corpus |
| B. Add ANN (`hnswlib-wasm` / `usearch`) | Persisted ANN index in IDB | Index versioning and rebuild-on-delete complexity; unjustified at target scale |
| C. Server embeddings | Embedding via remote API | Violates the client-side retrieval requirement |

At the stated scale (hundreds of files, roughly a few thousand chunks) approach A
scans in single-digit milliseconds and needs no index lifecycle management.

### TypeSafe integration

| Approach | Description | Fails first when |
| --- | --- | --- |
| **A. Gate + re-rank inside the `search` tool (chosen)** | TypeSafe runs inside retrieval; the LLM receives only routed evidence | Fast-search recall is poor (TypeSafe cannot recover a passage absent from the shortlist), or k calls/query become too expensive |
| B. TypeSafe as separate agent tools | Agent calls `rerank`, `check_premise`, `verify_citation` itself | Agent over-calls and step count / latency explodes |
| C. Citation verification only | Smallest change | Junk and injections still reach the generator before any check |

The chosen design merges both: a hard gate inside `search` (approach A) plus a
`verify_citation` tool the agent may invoke on demand (part of B), covering the
selected "both" and "full three checkpoints" scope.

### Crypto / vault

| Approach | Description | Fails first when |
| --- | --- | --- |
| **PBKDF2-SHA256 (600k) + AES-GCM via WebCrypto (chosen)** | No dependency; key held non-extractable in memory | Users want stronger KDF resistance |
| Argon2id via `hash-wasm` | Better memory-hard KDF | Adds a dependency; marginal benefit for a local vault |

## Chosen architecture

```
Ingest:  File -> chunk (heading/paragraph, 400-800 tokens, 10-15% overlap)
              -> embed("passage: " + chunk)   [transformers.js, local]
              -> AES-GCM encrypt -> Dexie { id, docId, ciphertext, iv, meta }

Query:
  [1] route_intent (TypeSafe, 1 call)
        needs_retrieval / premise_valid + reason
        premise invalid -> reply with warning, skip retrieval
  embed(query) -> decrypt-on-unlock vectors -> cosine scan -> shortlist k=12
  [2] grade_pair (TypeSafe, 1 call per pair, 5 questions in one request)
        rerank_score(Score) / is_relevant / has_evidence /
        contradicts_premise / contains_injection
      route() in code -> include | conflicting_evidence | exclude
  LLM API: search tool = hard gate; plus verify_citation tool
  [3] verify_citation (TypeSafe Choice + string match)
        -> verified | unsupported | contradicted | fabricated
```

### Key design decisions

- **One TypeSafe request per pair, not two.** Five independent questions share the
  same state in a single call (TypeSafe "parallel questions" / speculative fan-out
  guidance: roughly 12x cheaper and 10x faster than splitting). This replaces a
  separate re-rank call followed by a separate gate call.
- **Thresholds in code.** `THRESHOLDS` is the single place policy changes, so a
  policy edit costs no API calls.
- **Isolation boundary.** `embed()`, `search()`, `gradePair()`, and `route()` sit
  behind interfaces so the embedding model or ranking policy can change without
  touching UI or agent code.
- **Citation identity.** `search` returns chunk `id` and `docTitle` so citations map
  back to Dexie records rather than free text.

### Vault model

```
plaintext meta (Dexie, required before decryption)
  kdf:       { algorithm: pbkdf2-sha256, iterations: 600000, salt }
  canary:    EncryptedBlob          // wrong-password vs corruption
  version:   settingsVersion, persistedStorage, timestamps

settings (Dexie, encrypted blob; AAD-bound to its record id)
  providers: [{ id, label, kind, baseURL, apiKey, models[], defaultModel }]
  typesafe:  { apiKey, model: jev-latest, baseURL? }
  rag:       { embedModel, chunkSize, overlap, topK, thresholds, concurrency }

createLLM(settings, providerId, modelOverride?) -> LanguageModel
createTypeSafe(settings)                       -> TypeSafeClient
```

Unlock closes the loop: password -> PBKDF2 -> non-extractable AES-GCM key ->
decrypt settings blob -> hydrate config -> decrypt index blobs into memory -> ready.
Lock clears key and vectors from RAM.

## Recommendation

Approach A for retrieval, merged gate + verification for TypeSafe, PBKDF2 +
AES-GCM for the vault. The smallest design that satisfies the full requested scope;
its load-bearing assumption is embedding quality for Vietnamese text.

## Risks and unresolved questions

| Risk / unknown | Handling |
| --- | --- |
| Jev judgment quality on Vietnamese (docs make no multilingual guarantee) | Spike test in Phase 6. If weak, author `instructions`/`criteria` in English. `gradePair()` and `route()` isolate the change. |
| k=12 x 3-5 retrievals = 36-60 TypeSafe calls per query | Promise pool capped at ~4; cache by `sha1(query + passage)`; dedupe already-graded chunks. |
| `dangerouslyAllowBrowser` untested under the Vite browser bundle | Validate early in the core-infra plan before building on top. |
| Decrypt-all-on-unlock cost at a few thousand chunks | Measure during the RAG plan's search phase; store vectors as `Float32Array` blobs. |
| No LLM provider package installed | Core-infra plan adds `@ai-sdk/openai-compatible` at an exact pin and wires it through the registry. |
| Keys in browser memory are exposed to any injected script | Accepted for a local/personal app. A strict CSP and a no-`dangerouslySetInnerHTML` rule are the compensating controls; a public deployment needs a server proxy. |
| Prompt injection is not a security boundary | The injection score is a best-effort filter; the generator prompt instruction is the actual defense, and the failure class is documented rather than claimed solved. |
| Vault hardening deferred | PBKDF2 + AES-GCM accepted. `KdfParams` is a discriminated union so `argon2id` is expressible, but adding it needs `hash-wasm` plus a re-encrypt-and-migrate step. |

## Delivery split

Two sequential plans, core infrastructure first:

1. `plans/260918-1209-core-infra-vault` — vault shell, crypto, settings store,
   provider registry, both SDK factories.
2. `plans/260918-1210-rag-typesafe-pipeline` — ingest, search, TypeSafe module,
   three checkpoints, agent loop.
