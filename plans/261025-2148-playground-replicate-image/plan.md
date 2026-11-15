---
title: Playground — provider-based image generation and editing, Replicate first
description: A top-level Playground view runs image models through a provider contract, with Replicate as the first provider, and keeps results in an encrypted vault history.
status: in-progress
priority: P2
effort: 21h
branch: main
tags: [feature, frontend, api, database]
blockedBy: []
blocks: []
created: 2026-10-25
source: ../reports/brainstorm-261025-2137-playground-replicate-image.md
---

# Playground — provider-based image generation and editing

## Outcome

- The shell header gains a **Chat | Playground** switch. Playground replaces the conversation area with a form on the left and a results gallery on the right.
- Image providers plug in through one `PlaygroundProvider` contract and a registry. Replicate is the only provider in v1. Adding another provider means one adapter module, one registry entry, and its proxy rewrite; the store, form, gallery, and settings UI do not change.
- The user stores a provider token once in Config → Providers, encrypted in the vault.
- The user picks a provider and a model (quick-list or `owner/name`). The form is generated from the model's input schema. Image fields accept uploads, so edit models work.
- Run shows progress with Cancel. Cancel stops the prediction on the provider. Finished images show in the gallery.
- Every run is stored encrypted in the vault, with its images in a separate table. It survives reload and lock/unlock. A run that was still running at lock resumes after unlock, within the provider's retention window.
- Each run can be loaded back into the form, re-run, downloaded, saved into a Playground-owned folder, or deleted.

## Decisions (user, 2026-10-25)

- **Placement.** Top-level view (brainstorm).
- **Transport.** Same-origin host rewrites: Vite `server.proxy` / `preview.proxy` in dev and preview, `vercel.json` in production. No server code. The token travels per request and is never stored on the host (brainstorm).
- **Models.** Any model, with the form built from its input schema; a curated quick-list only pre-fills the model field (brainstorm).
- **Persistence.** Encrypted vault history with Download and Save to workspace (brainstorm).
- **Extensibility.** Provider code is abstract and reusable so other providers can be added later (user, mid-planning).
- **Red-team fixes.** All 15 accepted findings are applied (see Red Team Review).
- **Save target.** A Playground-owned folder handle, stored as `playground:folder` in `db.fs`. Playground never touches the conversation's workspace.
- **Lock mid-run.** Lock stops local polling. The prediction id is already stored, so after unlock a run younger than the provider's retention window resumes polling and downloads its output. Idle-lock behaviour is unchanged.
- **Output download.** Direct `fetch` from the provider's file host first. If that fails with a network or CORS error, retry once through a hardened `/replicate-files` proxy. That path accepts image extensions only and responds with a sandbox CSP, `Content-Disposition: attachment`, `nosniff`, and `no-store`.

## Defaults chosen by the planner (confirm in validation)

| Item | Value | Why |
|------|-------|-----|
| Create request | No `Prefer: wait`; poll from the first response | The prediction id must be known immediately so Cancel and resume work. |
| `Cancel-After` | `10m` (user) | Server-side cap so an abandoned prediction cannot keep running. |
| Poll interval | 1.5 s until terminal | Replicate recommends 1–2 s. |
| Resume window | 55 min after creation | Replicate removes API prediction data after one hour. |
| Inline input image | ≤ 256 KB as a data URI; larger through the provider's upload endpoint | Replicate's spec threshold. |
| Input image cap | 25 MB per file | Reuses `MAX_UPLOAD_BYTES` (`src/ui/composer-upload.ts:23`). |
| Output download cap | 100 MB per file, enforced while streaming | Reuses `REMOTE_BINARY_CAP` (`src/ui/file-view/load.ts:10`). |
| History cap | 200 runs and 1 GiB of stored image bytes (user); the oldest runs are pruned on every new run | Bounds IndexedDB use without a quota API. |
| Object URL cache | Revoked when a card unmounts; at most 48 live URLs | Bounds decrypted image memory. |

## Constraints

- Per-record AES-GCM through `encryptRecord` / `encryptRecordBytes` (`src/vault/records.ts`) and `vaultWriteQueue`. No plaintext prompt, model, or image data in Dexie rows.
- Every async continuation of a run records `keyring.getGeneration()` (`src/vault/keyring.ts`) at start and stops quietly if the generation changed.
- Dexie v9 only adds tables. Existing v8 data opens unchanged.
- `script-src` stays unchanged. The only CSP meta change is `blob:` in `img-src`.
- Tokens never appear in error messages, logs, stored runs, or the in-memory prediction copy.
- Schema text from model authors renders as plain text only.
- `deepMerge` cannot delete keys, so clearing a token uses an explicit setter like `setTerminal` (`src/vault/store.ts:339`).
- No code comments (user rule). Do not run `pnpm dev` or `pnpm build` without the user's go-ahead; the dev server is already running.

## Non-goals

- Providers other than Replicate in v1. The contract and registry are in scope; a second adapter is not.
- Video, audio, and text output rendering. Non-image outputs show as JSON.
- Fine-tuning, trainings, deployments, webhooks, and streaming outputs.
- A chat tool that calls the playground.
- Side-by-side comparison and batch runs.
- An SPA catch-all rewrite. The app has no client router.
- The production `/typesafe` proxy, COOP and `frame-ancestors` headers, and the missing `db.journals` clear in `recover()`. These are existing gaps, listed under Follow-ups.
- Cross-tab live sync of runs.

## Phases

| # | Phase | Depends on | Status |
|---|-------|------------|--------|
| 1 | [Provider contract, settings, and transport](phase-01-provider-contract-settings-transport.md) | — | completed |
| 2 | [Form model and OpenAPI mapper](phase-02-form-model-openapi-mapper.md) | 1 | completed |
| 3 | [Replicate provider adapter](phase-03-replicate-provider-adapter.md) | 1, 2 | completed |
| 4 | [Encrypted history and run lifecycle](phase-04-encrypted-history-run-lifecycle.md) | 1 | completed |
| 5 | [Playground view](phase-05-playground-view.md) | 1–4 | completed |
| 6 | [CSP, docs, and verification](phase-06-csp-docs-verification.md) | all | in-progress |

Phase 2 needs only the `FormField` type from phase 1. Phase 4 uses only the provider contract from phase 1 and a fake provider in its tests, so it can run alongside phases 2 and 3.

## Architecture after the plan

```
src/playground/
  types.ts  provider.ts  registry.ts  errors.ts  download.ts     provider-neutral contract
  form.ts  openapi-form.ts                                       neutral form model + OpenAPI mapper
  providers/replicate/{client.ts, index.ts}                      first adapter
  store.ts  state.ts                                             encrypted history + run lifecycle
  folder.ts                                                      Playground-owned save folder

settings.playgroundProviders[id] { apiKey, baseURL? }  ◄── setPlaygroundProvider ── PlaygroundProvidersSection (Config)
                     │
registry[id].create(config) ──► PlaygroundProvider
   verify · getModel · prepareImage · start · poll · cancel · download
                     │                         │
usePlaygroundStore ──┘  start → save predictionId → poll → download → save
   │ hydrate on first Playground mount, clear on session dispose, resume < 55 min
   ▼
db.playgroundRuns  { id, blob, createdAt }             AAD playground-run:<id>
db.playgroundImages { id: <runId>:<role>:<n>, runId, blob }   AAD playground-image:<id>
db.fs  playground:folder → directory handle

Transport: /replicate/v1/* ──► api.replicate.com   (no caching)
           replicate.delivery direct fetch, fallback /replicate-files/<sub>/<path>.<img-ext> (hardened headers)
```

## Acceptance criteria

1. With a valid token, `black-forest-labs/flux-schnell` generates an image in `pnpm dev` and on a Vercel preview deployment.
2. `black-forest-labs/flux-kontext-pro` accepts an uploaded input image and returns an edited one. An input above 256 KB goes through `POST /v1/files`.
3. A model typed by `owner/name` outside the quick-list renders its schema form and runs. A non-official model runs through `POST /v1/predictions` with its version id.
4. Cancel at any point after Run calls the provider's cancel endpoint, and the run ends `canceled` only after the provider reports a terminal status.
5. A run that was still running at lock resumes after unlock and stores its output when it is younger than 55 min. An older one shows `expired`.
6. A missing token, 401, 402, 404, 422, 429, and a failed prediction each show the provider's `detail` text or a specific fallback, never the token.
7. History survives reload and lock/unlock. Raw `db.playgroundRuns` and `db.playgroundImages` rows contain no prompt or image plaintext. `recover()` empties both tables and removes `playground:folder`. A new run past 200 runs or 1 GiB prunes the oldest runs, whatever their status.
8. Hydrate does not run in the session start chain, and opening Playground with 200 stored runs reads no image rows until a card renders.
9. Download and Save to workspace write the original bytes with an extension from `EXTENSION_BY_MEDIA_TYPE`. Saving never changes the open conversation's workspace.
10. A secret schema field is never stored, never re-sent as a placeholder, and must be entered again before Re-run.
11. `/replicate-files/...` returns the hardened headers on a Vercel preview, and an HTML or SVG path is rejected by the rewrite pattern.
12. With a chat approval pending, the Chat tab shows a badge while Playground is open.
13. `pnpm exec vitest run`, `rtk proxy pnpm exec tsc -b`, and `pnpm lint` pass. The build and the browser checks run only with the user's go-ahead.

## Verified facts (2026-10-25)

- `api.replicate.com` sends no CORS headers. A `replicate.delivery` preflight returned `access-control-allow-origin: *` (researcher). From this machine, every connection to `*.replicate.delivery` is reset (`curl: (35) Recv failure`), so the GET header could not be checked and the network itself may block the host.
- Production `/typesafe/` and deep paths return 404, and there is no `vercel.json`.
- Vercel external rewrites time out after 120 s to first byte. `x-vercel-enable-rewrite-caching: 0` disables rewrite caching.
- Vite matches string proxy keys by `startsWith` and the first match wins (`node_modules/vite/dist/node/chunks/node.js:19368`, `:19446`). Keys starting with `^` are regexes.
- Dexie is at `version(8)` (`src/vault/db.ts:184`). `recover()` (`src/vault/store.ts:354`) and `vaultInternals.reset` (`:410`) list tables by hand and already miss `db.journals`.
- Dexie maps a `QuotaExceededError` DOMException to its own error class (`node_modules/dexie/dist/dexie.mjs:440`), so `instanceof DOMException` checks miss it.
- `fetchLimitedBlob` (`src/ui/file-view/load.ts:32`) takes no signal, uses the global `fetch`, wraps `TypeError`, and checks size after buffering. It is not reused.
- `pickWorkspace` (`src/workspace/handle.ts:35`) writes the global `workspace` handle, and `useWorkspaceStore.pick` rebinds the current thread (`src/session/workspace-state.ts:104`). Playground uses neither.
- `keyring.getGeneration()` exists (`src/vault/keyring.ts`). `isSensitiveKey` (`src/tools/redact.ts:32`) and `EXTENSION_BY_MEDIA_TYPE` (`src/ui/composer-upload.ts:51`) exist but are not exported.
- `ApprovalPrompt` lives inside `Thread` (`src/components/assistant-ui/elements/thread.aui.tsx:574`) and reads `findPendingApproval` over the active thread's messages (`src/ui/approval-prompt.tsx:24`).
- `FORBIDDEN_KEYS` guards prototype keys in settings (`src/vault/settings.ts:216`).

Research: [Replicate HTTP API](../reports/researcher-261025-2142-replicate-http-api.md), [Vercel rewrite proxy](../reports/researcher-261025-2142-vercel-rewrite-proxy.md).

## Risks

- **`replicate.delivery` reachability.** This machine cannot reach the host at all. If the user's browser cannot either, both direct download and the proxy fallback still work only if Vercel can reach it; dev would fail. Phase 1 starts with a live check.
- **Rewrite behaviour is undocumented.** Header pass-through, multipart bodies, and whether `vercel.json` `headers` apply to external-rewrite responses must be confirmed on a preview. If the hardened headers do not apply, the `/replicate-files` rewrite is removed before shipping (phase 6 gate).
- **Open relay.** Anyone can relay their own token through `/replicate/v1/*`; the whole Replicate API lives under `/v1`, so the prefix is not a restriction. `/replicate-files` is an anonymous relay for image paths. No key is exposed; the cost is Vercel bandwidth. The README documents an optional WAF rate-limit rule.
- **Quota.** The byte budget is approximate. A quota error maps to a clear message and stops the save.
- **Schema variety.** Unsupported shapes fall back to a JSON field.
- **Unverified API details.** The 402, 422, and model 404 bodies and the exact `latest_version` shape are confirmed with a real token in phase 6.

## Red Team Review

### Session — 2026-10-25

**Findings:** 18 after deduplication (15 accepted, 3 rejected). Reviewers: Security Adversary, Failure Mode Analyst, Assumption Destroyer.
**Severity breakdown:** 1 Critical, 6 High, 11 Medium.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `/replicate-files` serves model files on the app origin with no CSP | Critical | Accept (user chose hardened proxy) | Phase 1, 6 |
| 2 | `fetchLimitedBlob` cannot abort, inject `fetch`, see `TypeError`, or cap while streaming | High | Accept | Phase 1 |
| 3 | Vite `/replicate` key captures `/replicate-files` | High | Accept | Phase 1 |
| 4 | Image bytes in the run row load on every unlock | High | Accept | Phase 4, 5 |
| 5 | `Prefer: wait` hides the prediction id; Cancel and lock orphan billed runs | High | Accept | Phase 3, 4 |
| 6 | Lock mid-run: late save under a new key, unhandled `VaultLockedError` | High | Accept | Phase 4 |
| 7 | Save to workspace through `pick()` rebinds the open conversation | High | Accept (user chose Playground-owned folder) | Phase 4, 5 |
| 8 | Quota mapping misses Dexie's wrapped error | Medium | Accept | Phase 4 |
| 9 | Chat approvals are invisible in Playground | Medium | Accept | Phase 5 |
| 10 | Secret fields replayed as `[redacted]`; name-based secrets missed | Medium | Accept | Phase 2, 5 |
| 11 | Pruning only on success; no byte bound; URLs not revoked | Medium | Accept | Phase 4 |
| 12 | `baseURL` accepts protocol-relative URLs | Medium | Accept | Phase 1 |
| 13 | Untrusted schema parser: `$ref` cycles, prototype keys, no caps, markup | Medium | Accept | Phase 2 |
| 14 | Model cache lifetime undefined | Medium | Accept | Phase 4 |
| 15 | `extensionForMimeType` falls back to png; `dataUriToBlob` unused | Medium | Accept | Phase 5 |
| 16 | v9 upgrade closes DB in old tabs | Medium | Reject: same behaviour as every earlier schema bump (`src/vault/db.ts:201`) | — |
| 17 | Add COOP and `frame-ancestors` headers now that `vercel.json` exists | Medium | Reject: existing gap (`vite.config.ts:19`), out of scope; listed under Follow-ups | — |
| 18 | `recover()` misses `db.journals` | Medium | Reject for this plan: existing bug; listed under Follow-ups | — |

### Whole-Plan Consistency Sweep

- `Prefer: wait=55` replaced everywhere by create-then-poll with `Cancel-After`.
- `fetchLimitedBlob` reuse removed; `download.ts` owns streaming download.
- The single `images` field on the run row replaced by the `playgroundImages` table.
- `useWorkspaceStore.pick()` and `regrant()` removed from the save path; `folder.ts` owns the Playground folder.
- `settings.replicate` replaced by `settings.playgroundProviders`.
- The `image.tsx` helper move removed.
- No contradictions remain.

## Validation Log

### Session 1 — 2026-10-25

Verification was skipped: the red-team reviewers already fact-checked every phase against the code (Fact Checker, Flow Tracer, Scope Auditor; no remaining `FAILED` claims after the edits).

| Question | Answer | Propagated to |
|----------|--------|---------------|
| History cap | 200 runs / 1 GiB | plan.md defaults, phase 4 (unchanged) |
| `Cancel-After` | 10 minutes | plan.md defaults, phase 3 |
| Conversations sidebar in Playground | Hidden; the rail stays | phase 5 (unchanged) |
| Quick-list | The seven listed plus `prunaai/z-image-turbo` | phase 3, phase 6 live check |

### Whole-Plan Consistency Sweep

- `30m` no longer appears; `Cancel-After: 10m` is in phase 3 and the defaults table.
- The quick-list appears only in phase 3; phase 5 reads it from the provider definition.
- No contradictions remain.

## Follow-ups (not in this plan)

- Production `/typesafe` rewrite in `vercel.json`.
- COOP and `frame-ancestors` response headers.
- `recover()` and `vaultInternals.reset` do not clear `db.journals`.
- Files uploaded through `POST /v1/files` stay in the user's Replicate account until Replicate expires them; the egress copy says so.

## Implementation Notes (2026-10-25)

### Gates

- `pnpm exec vitest run`: 182 files, 2162 passed, 1 skipped (pre-existing skip).
- `rtk proxy pnpm exec tsc -b`: clean.
- `pnpm lint`: clean.
- `pnpm build` not run (needs the user's go-ahead).

### Live API checks (script with the user's token, never printed)

- Token check, and all 8 quick-list schemas, map to forms. Every model is official, and the version id is `latest_version.id`.
- Error bodies: 404 is `{"detail":"Model not found."}`. 422 `detail` lists the invalid fields.
- A run starts without `Prefer: wait`, so the id returns immediately. Polling reaches `succeeded`, and cancel ends `canceled`.
- A 767 KB input uploads through `POST /v1/files`, and flux-kontext-pro edits it and succeeds.
- **New fact:** flux-schnell outputs are now presigned Cloudflare R2 URLs on `ai-gateway-outputs.<account>.r2.cloudflarestorage.com/provider-outputs/<uuid>/<uuid>?X-Amz-*`. They send no CORS headers. flux-kontext-pro outputs are still on `replicate.delivery`, which this machine cannot reach.

### Decisions made during implementation (user)

- Add a hardened `/replicate-r2/` relay (Vite and `vercel.json`) with strict host and path patterns, a required `X-Amz-Signature` query, and the same sandbox, attachment, nosniff and no-store headers. R2 outputs go straight to the relay.
- The R2 account id is not pinned, so the relay stays open to any account's `ai-gateway-outputs` bucket. The hardened headers still apply.
- Code review (7/10): fixed H1 (signature required), M1 (cancel an orphaned prediction after lock or delete during start), M2 (retry transient poll errors with backoff inside the retention window), M3 (hydrate retry), L1 (one failed save no longer stops the other resumes), L5 (Check token validates the base URL), and L11 (`state.ts` no longer imports the registry; retention lives on the provider instance). Remaining lows are in `../reports/code-reviewer-261025-2330-playground-replicate.md`.

### Deviations from the phase files

- `PlaygroundProviderId` and `PlaygroundProviderSettings` live in `src/vault/settings.ts`, so the vault does not import from the playground. `VaultSettingsError` was added.
- Name-based secret detection applies to text fields only. `format: password` is always secret.
- The Vite proxy has no `router`. The file relays wrap `proxy.web` to set a per-request target.
- View-switch logic lives in `src/ui/shell-view.ts` and `src/ui/view-switch.tsx`. `PlanPanel` renders only in the chat view.
- A download name falls back to the MIME subtype (the URL is not stored). Gallery images load only when visible.
- No CSP doc comment was added, per the user's no-comments rule.

### Not run yet (needs the user's go-ahead)

- Browser checks in dev or preview. The running `vite preview` on :4173 must restart to load the new proxy config.
- Vercel preview checks for AC1, AC2, AC11 and AC12. Confirm the hardened headers apply to external-rewrite responses on `/replicate-files` and `/replicate-r2`, and that the R2 query string reaches the destination. If the headers do not apply, remove both file relays before shipping.


### Follow-up fix (2026-10-26): "The file host returned HTTP 502"

- **Cause:** this network intermittently resets TLS connections to `replicate.delivery`. `curl` failed 3 of 5 times with exit 35, and the resets come in streaks lasting several seconds. The dev proxy forwarded the failed upstream connection as a 502. The code made one fallback attempt and gave up, which left a succeeded run with no image.
- **Fix:**
  - `downloadImage` now retries network errors and 502, 503 and 504 with backoff of 1, 2, 4 and 8 s. A final failure says the host could not be reached, instead of showing a bare HTTP 502. Measured on this network: 8 of 8 downloads succeeded, against 3 of 5 with a 5 s window.
  - A new Retry download action on a succeeded run that has no images re-polls the prediction for fresh links and saves the images into the same run. It works while the run is younger than the retention window. If it fails again, the run stays succeeded.
