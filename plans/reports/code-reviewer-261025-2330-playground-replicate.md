# Code review: Playground (Replicate image provider)

Date: 2026-10-25 · Scope: the uncommitted working tree on `main` (16 modified files, about 45 new files, about 4.7k new LOC including tests) · Plan: `plans/261025-2148-playground-replicate-image/plan.md`

The tree changed while I was reviewing. Around 23:33–23:35 someone edited `vite-proxy.ts`, `vercel.json`, `src/playground/providers/replicate/index.ts` (+ test), `src/playground/vite-proxy.test.ts` and `README.md` to add a `/replicate-r2/` relay. That relay is not in the plan or the list of intentional deviations. I reviewed it as it stood at 23:37.

## Verification run (read-only)

- `rtk proxy pnpm exec tsc -b`: passes, checked again after the concurrent edits.
- `pnpm lint`: passes, checked again after the concurrent edits.
- `pnpm exec vitest run`: 182 files passed, 2152 tests passed, 1 skipped (before the R2 edits). After the R2 edits, `src/playground` and `src/ui/playground` (13 files, 105 tests) pass.
- No code comments, `any`, lint suppressions, `dangerouslySetInnerHTML` or `innerHTML` in the new non-test code.

## Critical

None confirmed.

## High

### H1. `/replicate-r2/` relays to any Cloudflare account's bucket and allows any content type (new, outside the plan)
- Files: `vercel.json:16-19` and `:64-92`; `vite-proxy.ts:8-9` and `:37-45`; `src/playground/providers/replicate/index.ts:25` and `:99-103`.
- **Account not pinned.** The rewrite forwards `/replicate-r2/:account([0-9a-f]{32})/provider-outputs/:uuid/:uuid` to `https://ai-gateway-outputs.:account.r2.cloudflarestorage.com/...`. `:account` accepts any 32-hex Cloudflare account id. The client checks only the bucket name.
- **No extension check.** Unlike `/replicate-files`, this path has no image-extension guard, so the upstream object's `Content-Type` is passed through.
- **No signature required on Vercel.** The Vercel rule does not require an `X-Amz-Signature` query, so a public object in an attacker's bucket works.
- **Failure scenario.** An attacker creates bucket `ai-gateway-outputs` in their own Cloudflare account and uploads `text/html` at `provider-outputs/<uuid>/<uuid>`. They send a victim the link `https://<app>/replicate-r2/<attacker-acct>/provider-outputs/<uuid>/<uuid>`. Safety then depends entirely on whether Vercel applies the `vercel.json` `headers` block (sandbox CSP, `attachment`, `nosniff`) to external-rewrite responses. The plan lists that as unverified (Risks; AC11 gate).
  - If the headers do not apply, attacker HTML runs on the app origin. It can read IndexedDB ciphertext and `sessionStorage`, open and script same-origin app windows, and phish the vault password.
  - Even if they do apply, the route is an open bandwidth relay for any R2 account.
- **Fix.**
  - Pin Replicate's account id. The test fixture uses `0d37909e38d3e99c29fa2cd343ac421a`. Put it in the Vercel `source` and `destination` literally, in `REPLICATE_R2_PROXY_KEY`/`replicateR2Route`, and in `R2_OUTPUT_HOST`.
  - Add a `has: [{ "type": "query", "key": "X-Amz-Signature" }]` condition to the Vercel rewrite.
  - Put this path under the same phase-6 gate as `/replicate-files`: remove it before shipping if a preview shows the hardened headers missing.
  - Record the new path as a plan deviation.

## Medium

### M1. Lock or Delete while `provider.start` is in flight leaves a billed prediction with no stored id
- File: `src/playground/state.ts:240-249` (also `remove` at `:399-412`).
- **Lock.** If the vault locks during `provider.start`, `alive()` turns false, so the prediction id is never saved and nothing cancels the prediction. After unlock, `hydrate` marks the run `interrupted` ("stopped before the provider accepted it"), but Replicate keeps running and billing it for up to `Cancel-After: 10m`. The output is lost.
- **Delete.** Pressing Delete during `start` aborts the fetch after the server may already have created the prediction. Same result.
- This breaks the plan's lock decision, which assumes "the prediction id is already stored".
- **Fix.** After `start` returns, if `!alive()` or `save` returned false, fire `provider.cancel(run.providerRunId).catch(() => undefined)` before returning. The provider object still holds the token.

### M2. One failed poll marks a still-running prediction as `failed` forever
- File: `src/playground/state.ts:253-271`.
- **Failure scenario.** Any poll error ends the run as `failed`, and `failed` is terminal, so `hydrate` never resumes it. Errors that trigger this include a `TypeError` (Wi-Fi blip, laptop sleep), a 429, or a transient 5xx. The prediction usually still succeeds on Replicate, and the user pays for an output they never get.
- **Fix.** Retry `network`, `rate_limited` and 5xx poll errors with backoff until the retention window or a retry cap. If retries run out, leave the run non-terminal (or `interrupted` with the id kept) so the next hydrate can resume it.

### M3. A failed `hydrate` can never be retried until lock
- File: `src/playground/state.ts:331-333`.
- **Cause.** `hydrating = task.finally(() => { if (hydrating === task) hydrating = null })`. `hydrating` holds the promise returned by `.finally()`, never `task`, so the reset never fires.
- **Failure scenario.** `persistence.list()` fails once (for example a Dexie `DatabaseClosedError` during a blocked upgrade). `error` is shown and `hydrated` stays false. Every later `hydrate()`, including remounting Playground, returns the old resolved promise, so the gallery stays empty until lock/unlock calls `clear()`.
- **Fix.** `const wrapped = task.finally(() => { if (hydrating === wrapped) hydrating = null }); hydrating = wrapped; return wrapped`. Add a test that rejects `list` once and then expects a second `hydrate` to load.

## Low

- **L1. One failed save stops the resume loop** (`state.ts:312-326`). If `save` throws for one run (quota, or `VaultLockedError` racing the stamp), the loop stops. Later non-terminal runs show `processing` with no Cancel button and no progress line until the next session. Fix: wrap each iteration in its own try/catch.
- **L2. The URL cap revokes URLs that are still in use** (`state.ts:133-146`, with `run-gallery.tsx:32-50`). `trimUrls` evicts by least recent use even when `refs > 0`. Cards never release a URL when they scroll off screen; `useInView` only latches to true. So after about 48 thumbnails have been seen, mounted cards hold revoked URLs. Opening `ImageZoom` on them may show a broken image (needs a browser check). Memory is not freed either, because the `<img>` still holds the decoded image. Fix: evict only entries with `refs === 0`, or release when a card leaves the viewport.
- **L3. Without a token the history is hidden** (`playground-view.tsx:103-120`). Existing runs cannot be viewed, downloaded or deleted after the token is removed. Fix: render the gallery under the empty state; disable only Run, Re-run and Use settings.
- **L4. Images upload before the form is validated** (`playground-view.tsx:148-159`). `prepareImage` uploads files over 256 KB to `POST /v1/files` before `toProviderInput` checks required fields. A form error still leaves the user's image in their Replicate file storage, and each retry uploads it again. Fix: validate first (for example with placeholder URIs for image fields), then upload.
- **L5. Check token skips base URL validation** (`PlaygroundProvidersSection.tsx:65-68`). `checkToken` passes the raw draft `baseURL` to `definition.create`, bypassing `normalizePlaygroundBaseURL`. That is the red-team #12 guard against `//host`, `/\host` and plain `http://`. The setter rejects the value, but the check has already sent `Authorization: Bearer <token>` there. Fix: normalize first and show the setter's message when the result is null.
- **L6. Closing Config within 400 ms drops the last token edit** (`PlaygroundProvidersSection.tsx:30-35`). The unmount cleanup clears the pending debounce timer. `TypeSafeSection` does not clear its timer, so it still saves. Fix: flush on unmount instead of clearing.
- **L7. Re-run uses the latest version; the stored `ref` is never read** (`playground-view.tsx:176-205`, `state.ts:370`). Re-run calls `resolveModel` again, so a community model runs its current latest version, not the one recorded in `meta.ref`. The persisted `ref` is never read. Fix: either re-run with the stored `versionId` or stop persisting `ref`.
- **L8. Slow model loads can overwrite a newer form** (`playground-view.tsx:135-140`). Two `onResolve` calls are not sequenced, so a slow first response can replace the form for a model picked later. Fix: use a request counter or an AbortController.
- **L9. Use settings, then Run, sends without the secret** (`playground-view.tsx:197-202`). Phase 5 says secrets "stay empty and required". After Use settings, Run proceeds when an optional secret is left blank; only Re-run is blocked. AC10 as written (Re-run) is met.
- **L10. Approval check runs on every chat update** (`shell-view.ts:25-28`). The `useShellView` selector runs `findPendingApproval` over the whole active thread on every chat-store change, including streaming deltas, now in chat view too. `ApprovalPrompt` already does the same scan. Cheap per call, but O(parts) per token. Fix: read it only while in playground view, or memoize on the messages reference.
- **L11. Playground code lands in the main bundle** (`state.ts:6`). `session-provider` → `state.ts` → `registry` pulls the Replicate adapter, `chat/attachments` and `ui/file-view/load` into the main chunk, which partly defeats the `lazy()` view. `PROVIDERS` is imported only for `retentionMs`. Fix: put the retention on the resolver result.

## Explicit checks

### (a) Acceptance criteria

| # | Status |
|---|---|
| 1 | Needs a live run. The code path exists. |
| 2 | Needs a live run. Inline ≤ 256 KB vs `POST /v1/files` is unit-tested. |
| 3 | Met: schema form, and `owner/name:versionId` through `/v1/predictions` (tests). |
| 4 | Met (tests). See M1 for the start-time cancel gap on lock or delete. |
| 5 | Met (test: lock mid-poll, resume, expired after 56 min). Gap: M1. |
| 6 | Met. `detail`/`title`, then a fallback, are token-redacted. A missing token shows the empty state, not an error message. |
| 7 | Met: no plaintext in raw rows (test); `recover()` clears both tables and `db.fs`; pruning by count and bytes for every status (tests). |
| 8 | Met: hydrate runs only on Playground mount; `listRunMeta` never touches `playgroundImages` (test); image reads are gated by IntersectionObserver. |
| 9 | Met: extension from `EXTENSION_BY_MEDIA_TYPE`; separate folder handle, never `pick` (test). |
| 10 | Met: never stored, never a placeholder, Re-run blocked. |
| 11 | Needs a live run. The dev proxy headers are unit-tested with a mock. H1 widens the surface. |
| 12 | Met (test). |
| 13 | Met for vitest, tsc and lint. Build and browser checks were not run, as instructed. |

### (b) Regressions in touched code
- `recover()` and `vaultInternals.reset` add both tables inside the existing transaction or sequence. `playground:folder` is removed through `db.fs.clear()`.
- `migrate()` adds `playgroundProviders` only when valid. Other fields are unchanged and existing settings keep their shape (tests).
- Session dispose calls `clear()` before `session.dispose()`. It aborts loops and revokes URLs, and does not cancel predictions (by design).
- Chat-view rendering is unchanged apart from the header `ViewSwitch` (and L10). `PlanPanel` and the sidebar are hidden only in Playground.
- `ProvidersPanel` only appends a section.
- Dexie v9 repeats every v8 store exactly and adds two tables. The v8 open test passes, and `mcp/store.test` was updated to verno 9.

### (c) Public contracts
All additive:
- `VaultState.setPlaygroundProvider`.
- New exports: `FORBIDDEN_KEYS`, `isSensitiveKey`, `toDataUrl`, `EXTENSION_BY_MEDIA_TYPE`, `VaultSettingsError`.
- An optional settings field.
- Two new Dexie tables.

No env vars changed. The preview proxy now also carries the replicate routes. The local `typesafeProxy` const was renamed to `devProxy`.

### (d) Repo patterns
- Write queue use, envelope versioning, AAD seeds `playground-run:<id>` and `playground-image:<id>`, and the `parseEnvelope` shape match `memory/store.ts`.
- Encryption and `blob.arrayBuffer()` run outside Dexie transactions. Transactions contain only Dexie calls, so there is no transaction misuse.
- The keyring generation stamp and session counter are checked after every await.
- The setter follows the `setTerminal` pattern with a key identity check.
- The zustand store factory and persistence seam match `memory/state`. Tests use `installKey` and a fake provider.

### (e) Lint, type and build
- tsc and lint are clean, and all tests pass.
- Build not run.

### Security
- **Token handling:**
  - **Errors:** the `Authorization` header is set only toward the configured base URL. Errors pass through `redactToken` (exact token plus `redactSecrets`).
  - **Downloads:** they use `credentials: 'omit'` with no auth header.
  - **Stored data:** the token is never in `RunMeta`, `ProviderRun` or the model cache.
  - **Secret fields:** they are removed by `storableInput`. Image inputs are stored as `{ $image: n }` references, never data URIs.
- **Schema text and XSS:** everything renders as React text. `$ref` resolution is one level, prototype keys are skipped, and fields, options and text are capped.
- **Vite file proxy:** I confirmed Vite 8 calls `proxy.web(req, res, options)` through the instance property (`vite/dist/node/chunks/node.js:19469`), so the `configure` wrapper takes effect. I did not check that http-proxy-3 merges the per-call `target`.

## Intentional deviations
All the listed deviations look sound. The R2 relay is not one of them (H1).

## Score: 7/10

The core lifecycle, persistence and vault integration are careful and follow repo patterns, with real behavioral tests. Points come off for the unpinned R2 relay added mid-review (H1) and three lifecycle robustness gaps (M1–M3) that lose billed outputs or block history in realistic conditions.

## Unresolved questions
1. Is the R2 relay meant to ship in v1? If so, which account id(s) does Replicate use, and has it been checked against a live output?
2. Does Vercel apply `headers` to external-rewrite responses? This is still the gate for both file relays (AC11).
