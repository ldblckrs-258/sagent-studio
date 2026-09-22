# Phase 5 — Manual browser checklist record

Status: **NOT RUN in this environment.** The implementation session had no
browser and no display, so the Chromium checklist below could not be executed.
This is a recorded deviation, not a pass. Every line must be run by a human
against `pnpm dev` and then `pnpm build` + `pnpm preview` before the plan is
closed.

What is covered by automated tests instead is noted per line. The remaining
lines are the acceptance evidence that only a real browser can produce.

| # | Checklist item | Result | Automated coverage |
| --- | --- | --- | --- |
| 1 | Embedding provider/model defaults and persists to `rag.embedProviderId`/`rag.embedModel` | Not run | `library-state.test.ts` proves the picked provider is honored |
| 2 | Four RAG tools available in the Tools panel; no panel error | Not run | `session.test.ts` proves the four tools are listed |
| 3 | Add `.txt`, `.md`, `.pdf`; progress advances; chunk counts list | Not run | `ingest.test.ts` (text/markdown), `pdf.test.ts` (extraction seam) |
| 4 | Reload, unlock, library lists identically with no re-index | Not run | `ingest.test.ts` persists across a table reopen |
| 5 | DevTools: `documents`/`chunks` hold only `iv`/`ciphertext`; no plaintext phrase or vector | Not run | `store.test.ts` asserts a plaintext marker and a vector value are absent from the raw row |
| 6 | Wrong password reveals nothing | Not run | `store.test.ts` proves reads throw under a different key |
| 7 | Tool call renders as a citation card | Not run | `rag.test.ts` proves the result envelope; card is component-only |
| 8 | False-premise question reports the conflict | Not run | `rag-e2e.test.ts` proves `conflicting_evidence` and the directive |
| 9 | Hidden-instruction document is withheld and counted | Not run | `rag-e2e.test.ts` proves the marker never reaches result or prompt |
| 10 | `verify_citation` returns `fabricated` and `contradicted` | Not run | `rag-e2e.test.ts` proves both verdicts |
| 11 | Target-scale hydration and scan: record median, mode, dims, budget | Not run in browser | `retrieval.test.ts` target-scale fixture + `reports/phase-02-target-scale-measurement.md` (resident median 15.26 ms, dims 16, 128 MiB budget) |
| 12 | Offline: listing/reading work, new query reports provider unreachable | Not run | `retrieval.test.ts` / architecture: only `embedQuery` is network |
| 13 | Lock clears the vector index; retrieval reports unavailable | Not run | `index-cache.test.ts` and `lifecycle.test.ts` prove generation-guarded clear |
| 14 | `pnpm build` output loads without a CSP violation | Not run | `pnpm build` succeeds; CSP meta is injected by `vite.config.ts` |
| 15 | Hostile PDF: malformed, JS actions, huge page count | Not run | `pdf.test.ts` proves the extraction cap; caps enforced in `ingest.ts` |
| 16 | Two-tab schema upgrade surfaces the "close other tabs" notice | Not run | `db.ts` handlers; `fake-indexeddb` cannot reproduce a second-tab upgrade |

## "Close other tabs" notice

`isDatabaseBlocked()`/`subscribeDatabaseBlocked()` in `src/vault/db.ts` are wired
to the Dexie `blocked` event, and `DatabaseBlockedNotice` in
`src/session/session-provider.tsx` now renders the banner. Checklist line 16
still needs a two-tab browser run to confirm the event fires and the notice
shows in a real Chromium session.

## Paged-mode measurement

The phase 2 report records the resident-mode target-scale median. A paged-mode
median at the same scale is only produced by checklist line 11 and is therefore
still outstanding.
