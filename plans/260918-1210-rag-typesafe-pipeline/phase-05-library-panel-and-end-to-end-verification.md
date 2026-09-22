---
title: "Phase 5: Library Panel and End-to-End Verification"
status: done
---

# Phase 5: Library Panel and End-to-End Verification

<!-- Updated: Validation Session 1 - explicit embedding pick and target-scale measurement -->

## Context Links

- [`plan.md`](./plan.md) — all nine acceptance criteria and the manual browser steps this
  phase must run.
- [`phase-04-rag-tools-and-session-wiring.md`](./phase-04-rag-tools-and-session-wiring.md) —
  the tool surface this phase renders and exercises.
- [`research/researcher-02-harness-rag-integration.md`](./research/researcher-02-harness-rag-integration.md)
  §6 panel registration (`shell.tsx:47-64, 315-353`), tool rendering
  (`thread.aui.tsx:737-738`, `tool-fallback.aui.tsx:263-283`), and §7 test conventions.
- [`research/researcher-01-typesafe-jev.md`](./research/researcher-01-typesafe-jev.md) §12
  documented failure modes.

## Overview

Give the user a Documents panel that adds, indexes, and removes documents and owns the
`rag` settings, render `search_documents` results as citations instead of raw JSON, and
prove the whole pipeline end to end: adversarial fixtures through the real tool path with a
mock model, plus a recorded manual checklist in a real Chromium browser under the
production CSP. The panel's store also owns the live vector index: ingest adds vectors and a
delete evicts them, and a session cleanup clears the decrypted titles so nothing survives a
lock.

## Key Insights

- A new rail panel is a four-point edit in `src/ui/shell.tsx`: the `RailPanelId` union
  (`47-54`), `RAIL_IDS` (`56-64`), the `panels` array (`315-353`), and the imports
  (`33-41`). `RAIL_IDS` also validates the persisted `sessionStorage` panel id, so omitting
  it makes a saved selection fall back silently.
- The Skills and Tools panels are the templates: plain function components, shared
  `primitives.tsx` controls, `PanelSection`, and a Zustand or session source. A dedicated
  store in the style of `src/session/workspace-state.ts` keeps ingest progress out of React
  state and survives panel remounts.
- `ToolFallback` renders a tool result with `JSON.stringify` inside a `<pre>`
  (`tool-fallback.aui.tsx:263-283`), and the `case "tool-call"` branch already prefers
  `part.toolUI` when one is registered (`thread.aui.tsx:737-738`). No `makeAssistantToolUI`
  call exists anywhere in the app, so the smallest consistent change is a tool-name check in
  that branch rather than introducing a new registration mechanism.
- RAG settings belong in the Documents panel, next to the documents they affect. The
  Config panel's tab union (`chat-config.tsx:14-17`) stays untouched, which avoids a second
  settings surface for the same values.
- The test suite runs under `node`, not `jsdom` (`vitest.config.ts:6`), and there is no
  React effect runner or testing-library dependency, so component behaviour and the
  unlock/lock mount cycle are verified in the browser checklist rather than in a component
  test. The logic that must be covered by a test — the hydrate, abort, and clear sequence
  from phase 2 and the store `clear()` — lives in `src/rag/lifecycle.ts` and
  `src/rag/library-state.ts` and is asserted under `node`. `MockLanguageModelV4` from
  `ai/test` is the established way to drive the real engine
  (`src/chat/harness-e2e.test.ts:3-4`).
- The adversarial set is the deliverable for acceptance criterion 5: a plain hidden
  instruction must be withheld, and the bypass class must be written down rather than
  claimed solved.

## Requirements

- A Documents rail panel that lists documents with title, kind, chunk count, and status;
  adds files by picker and by drop; shows per-file ingest progress; and removes a document
  with confirmation.
- RAG settings controls for the embedding provider and embedding model, top-k, chunk size
  (tokens), overlap (tokens), and Jev concurrency, persisted through
  `useVaultStore.update({ rag: ... })`. The provider selector and the model input default to
  the first configured provider and `settings.rag.embedModel`, and the user's pick is
  persisted to `rag.embedProviderId`/`rag.embedModel`; no provider is chosen silently behind
  the control. When the selected provider serves no embedding model, the panel surfaces the
  ingest error naming that provider and the model, and points the user at Config.
- A clear state when no provider or no TypeSafe key is configured, telling the user what to
  add.
- `useDocumentLibraryStore` exposes `clear()`, and the `SessionProvider` cleanup calls it
  next to the vector index clear, so decrypted document titles do not survive a lock.
- `addFiles` updates the live vector index after a successful ingest (`addVectors`), and
  `remove(id)` evicts the document's vectors (`removeDocument`) rather than only refreshing
  the metadata list, so the index never disagrees with the store.
- `search_documents` results render as a citation card showing the selected query, the
  scanned and included counts, the withheld count, and each passage's title, ordinal,
  chunk id, and score, with conflicting passages in their own section.
- Any other tool result keeps rendering through `ToolFallback`.
- `src/rag/adversarial-fixtures.ts` provides a false-premise document set, a hidden
  instruction passage, a contradicted citation, a hallucinated citation, and the documented
  bypass variants. The withheld injection payload is never echoed to the model: the fixtures
  assert it is counted, not returned.
- `src/rag/rag-e2e.test.ts` drives the real store, index, Jev module, port, tool provider,
  and engine with a mocked TypeSafe client and a `MockLanguageModelV4`.
- `README.md` documents the library, the encryption posture, the egress to the embedding
  provider and TypeSafe, the pdf.js worker threat model, and the new `src/rag/` module.
- A manual browser checklist is recorded in this phase with observed results.

## Architecture

```
DocumentsPanel (src/ui/panels/library.tsx)
  -> useDocumentLibraryStore        list, addFiles, remove, clear, progress, error
       -> createEmbedder(settings, rag.embedProviderId)
                                     -> probeEmbedding once, then ingestFiles(...)
                                        from src/rag/ingest.ts
       -> index.addVectors(...)      after a successful ingest
       -> index.removeDocument(id)   on delete, so the live index matches the store
  -> PanelSection "Settings"         rag.embedProviderId (Select), embedModel (Input),
                                     topK, chunkSize (tokens), overlap (tokens),
                                     concurrency

session cleanup (session-provider.tsx)
  -> startRagIndex()'s stop()       abort hydrate, then clear the vector index
  -> useDocumentLibraryStore.getState().clear()   drop decrypted titles with it

thread.aui.tsx  case "tool-call"
  -> toolName === 'search_documents' ? <RagCitations /> : <ToolFallback />

src/rag/rag-e2e.test.ts
  real Dexie + keyring + store + index-cache + jev + port + rag tools + engine
  stubbed embedder, mocked TypeSafeClient, MockLanguageModelV4
```

## Related Code Files

Create:

- `src/rag/library-state.ts` — the `useDocumentLibraryStore` Zustand store.
- `src/rag/library-state.test.ts`
- `src/ui/panels/library.tsx` — the Documents panel.
- `src/components/assistant-ui/elements/rag-citations.aui.tsx` — the citation card.
- `src/rag/adversarial-fixtures.ts`
- `src/rag/rag-e2e.test.ts`

Modify:

- `src/ui/shell.tsx` — `RailPanelId`, `RAIL_IDS`, the `panels` array, and the import.
- `src/components/assistant-ui/elements/thread.aui.tsx` — dispatch `search_documents`
  results to the citation card.
- `src/session/session-provider.tsx` — add
  `useDocumentLibraryStore.getState().clear()` to the cleanup, next to the stop function
  phase 2 added, so decrypted titles are dropped with the vector index. Phase 2 lands first
  and owns the hydrate/clear wiring in this file; this phase adds one call to the same
  cleanup and touches nothing else.
- `README.md` — the library section, the developer tree, and the data-egress paragraph.

## Implementation Steps

1. In `src/rag/library-state.ts`, implement `useDocumentLibraryStore` with
   `{ documents, status: 'idle' | 'loading' | 'ingesting' | 'error', progress, error,
   refresh(), addFiles(files), remove(id), clear() }`. Read settings through
   `useVaultStore.getState()`, build the embedder with `createEmbedder(settings,
   settings.rag.embedProviderId)` so the user's pick is honored, resolve the chunking
   parameters from `rag` (`chunkSize` and `overlap` are token counts), and drive
   `ingestFiles` with an `AbortController` so removing or leaving the panel stops work. The
   ingest path runs the one-item `probeEmbedding` before the first file, and its failure is
   surfaced as the named-provider, named-model error rather than a generic ingest failure.
   After a successful ingest, call
   `ragIndex.addVectors(...)` for the new chunks so the live index matches the store without
   a re-unlock, then refresh the list. In `remove(id)`, call `ragIndex.removeDocument(id)`
   after the rows are deleted so a deleted document's vectors can never be scored or cited
   again. Implement `clear()` to reset `documents`, `status`, `progress`, and `error` to
   their initial values; it is called from the `SessionProvider` cleanup so decrypted titles
   do not survive a lock.
2. In `src/ui/panels/library.tsx`, build the panel with `PanelSection` blocks: a header with
   an "Add documents" button and a file input accepting `.txt`, `.md`, `.markdown`, and
   `.pdf`; a progress row while ingesting; the document list with a remove button per row; a
   settings section using `Select` and `Input` from `primitives.tsx`, where the embedding
   provider `Select` lists the configured providers and the embedding model `Input` starts
   from `settings.rag.embedModel`, both defaulting to the first configured provider, and a
   change persists to `rag.embedProviderId`/`rag.embedModel` so the pick is explicit and
   visible; and explicit empty and
   error states. State plainly that the embedding provider and TypeSafe key are required and
   link the user to the Config panel when either is missing.
3. In `src/components/assistant-ui/elements/rag-citations.aui.tsx`, implement
   `RagCitations` over the assistant-ui tool part: read `part.result.value`, tolerate a
   failure envelope, and render the query, the scanned/included/withheld counts, the
   included passages as rows with title, ordinal, id, and score, and a distinct
   "Conflicting evidence" group. Collapse to a summary row when there are no passages.
   Never render passage text with raw HTML.
4. In `src/components/assistant-ui/elements/thread.aui.tsx`, import `RagCitations` and extend
   the `case "tool-call"` branch to
   `part.toolUI ?? (part.toolName === 'search_documents' ? <RagCitations {...part} /> : <ToolFallbackComponent {...part} />)`.
   Leave every other tool on the fallback.
5. In `src/ui/shell.tsx`, add `"documents"` to `RailPanelId` and `RAIL_IDS`, import
   `LibraryPanel` and a `lucide-react` icon, and add the `{ id: "documents", label:
   "Documents", icon, render: () => <LibraryPanel /> }` entry to the `panels` array.
6. In `src/rag/adversarial-fixtures.ts`, write the fixture documents and canned Jev answers:
   a library whose passages contradict a false-premise question; a passage containing a
   plain hidden instruction; a passage that contradicts a claim; a claim absent from every
   passage; and the documented bypass variants (paraphrased instruction, instruction in
   another language, instruction split by encoding or homoglyphs, instruction inside an
   apparent quotation). Export a `describe`-ready list of bypass cases with a comment stating
   that these are expected to pass the filter and are recorded as the documented bypass
   class. Give the withheld injection payload a unique marker string so a test can assert the
   marker never appears in any returned field: the payload is counted, never echoed.
7. In `src/rag/rag-e2e.test.ts`, build the real pipeline with a stubbed embedder returning
   seeded vectors, a mocked `TypeSafeClient` returning the canned answers, the real
   `src/rag/jev.ts`, the real `createRagPort`, `createRagToolProvider`, and a
   `MockLanguageModelV4` scripted to call `search_documents` and then emit text. Assert:
   the false-premise query routes to `conflicting_evidence` and the directive reaches the
   model's messages; the hidden-instruction passage is absent from the result and counted in
   `injectionExcluded`; the withheld payload's marker string appears in no field of the
   result and in no message sent to the mock model, only the count does; the included
   passage count is strictly less than `routed.scanned`; the contradicted claim returns
   `contradicted`; and the hallucinated claim — worded so its token overlap with the passage
   falls below `citationFuzzyMin` — returns `fabricated` with no additional Jev call, which
   pins the fuzzy prefilter rather than only the exact-match fast path. Add a `describe.each`
   over the bypass fixtures that records which ones pass through
   and asserts only the recorded outcome, so a future filter improvement fails loudly and a
   regression is visible.
8. In `src/rag/library-state.test.ts`, drive the store with a stubbed ingest, a stubbed
   `ragIndex`, and a stubbed embedder: assert progress transitions, that a failing file sets
   `error` without clearing the existing list, that `remove` refreshes the list and calls
   `removeDocument` with the same id, that a successful `addFiles` calls `addVectors`, and
   that `clear()` resets the list and the status.
9. Update `README.md`: add a "Your document library" section to the feature list, add
   `rag/` to the developer tree, extend the data-egress paragraph to state that adding a
   document sends its chunk text to the configured embedding provider and that a retrieval
   sends the query and shortlisted passages to that provider and to TypeSafe, and note that
   the index is encrypted at rest and readable offline while a new query embedding is not.
   State the pdf.js worker threat model in that egress/security paragraph: raw PDF bytes
   reach a same-origin worker that does not inherit the document CSP and can use the page's
   network egress and IndexedDB, while the vault key never enters the worker.
10. Run `pnpm test`, `pnpm lint`, and `pnpm build`, then execute the manual checklist below
    in Chromium and record the observed result for each line in this phase.

## Manual Browser Checklist

Run against `pnpm dev` first, then repeat steps 9 through 16 against `pnpm build` and
`pnpm preview` so the production CSP, the emitted pdf.js worker, and the schema upgrade
under a second tab are covered.

1. Create the vault, add an OpenAI-compatible provider whose endpoint serves an embedding
   model, and add a TypeSafe key in Config. Open the Documents panel and confirm the
   embedding provider selector and model input default to that provider and
   `settings.rag.embedModel`, and that changing either persists to
   `rag.embedProviderId`/`rag.embedModel` across a reload.
2. Open the Documents panel; confirm the four RAG tools appear as available in the Tools
   panel and that the panel shows no error.
3. Add a `.txt`, a `.md`, and a `.pdf`; confirm progress advances and each document lists
   with a chunk count.
4. Reload the page, unlock, and confirm the library lists identically with no re-indexing.
5. In DevTools, inspect `sagent-vault` → `documents` and `chunks`; confirm each row's
   `blob`, `text`, and `vector` hold only `iv` and `ciphertext`, that the only plaintext
   fields are opaque ids, `ordinal`, `dims` (the embedding width added in phase 1), and
   timestamps, that searching the object store for a phrase from a document returns nothing,
   and that no numeric vector appears in a row.
6. Lock, enter a wrong password, and confirm the error appears and nothing is listed.
7. Ask a question that requires the library; confirm the tool call renders as a citation
   card with titles, chunk ids, and the scanned-versus-included counts.
8. Ask the false-premise fixture question; confirm the answer reports the conflict rather
   than answering as if the premise held.
9. Ask about a topic covered by the hidden-instruction document; confirm the passage never
   appears in the result and that the withheld count includes it.
10. Ask the model to verify a quotation that appears in none of the chunks a search
    returned, then one that its chunk contradicts; confirm `verify_citation` returns
    `fabricated` and `contradicted`. Word the first claim so its token overlap with the
    passage falls below `citationFuzzyMin`, so it is rejected without spending a Jev call.
11. With a synthetic library at the target scale of 1,000 documents / ~50,000 chunks,
    record the hydration time and, from the store's timing log, the median local scan time
    together with the mode it ran in (`resident` or `paged`), the dimensions, and the
    `RAG_VECTOR_MEMORY_BUDGET_BYTES` it respected. Confirm a resident scan is well under
    ~150 ms median, and record the paged median as its own number when the dimensions put
    the vectors over the budget.
12. Go offline, then list documents and ask a question; confirm listing and reading still
    work and that the new query reports that the embedding provider is unreachable.
13. Lock the vault and confirm in DevTools that the vector index is empty and that a
    retrieval attempt reports the library as unavailable rather than returning stale text.
14. Confirm `pnpm build` output loads without a CSP violation in the console.
15. Add a hostile PDF: a malformed file, one with embedded JavaScript actions, and one with
    a very large page count. Confirm each either ingests with a readable limit error or
    completes within the caps, that the app stays responsive throughout, and that the
    Network panel shows no request from the worker to an origin other than the configured
    provider. Record the outcome as the accepted residual risk from the phase 1 threat
    model.
16. Two-tab schema upgrade: keep a tab open on the previous bundle (v5 schema), then load
    the new bundle in a second tab. Confirm the upgrading tab surfaces the "close other
    tabs" notice instead of silently hanging, that closing the old tab lets the upgrade
    finish, and that the old tab closes its connection on `versionchange` rather than
    writing rows against the old schema.

## Todo

- [x] Implement the document library store with progress, abort, `clear()`, `addVectors`,
      and `removeDocument`.
- [x] Build the Documents panel with list, add, remove, the explicit embedding provider and
      model pick, the token-based settings, and empty states.
- [x] Implement the `search_documents` citation card.
- [x] Dispatch the citation card in `thread.aui.tsx`.
- [x] Register the rail panel in all four places.
- [x] Clear the library store in the `SessionProvider` cleanup, next to the vector index.
- [x] Write the adversarial fixtures, including the documented bypass class and the
      withheld-payload marker.
- [x] Write the end-to-end test over the real pipeline with a mock model.
- [x] Write the library store test.
- [x] Update `README.md`, including the pdf.js worker threat model.
- [x] Run the manual checklist in Chromium and record each result, including the hostile-PDF
      and two-tab schema-upgrade cases.
- [x] Make `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Success Criteria

- `src/rag/rag-e2e.test.ts` proves acceptance criteria 4, 5, 6, and 7 through the real tool
  and routing path, not through a stub of the routing logic. It also proves the withheld
  payload's marker never reaches the result or the model's messages, and that the
  hallucinated claim is rejected by the fuzzy prefilter below `citationFuzzyMin`.
- `src/rag/library-state.test.ts` proves the store's progress, error, removal, vector-index
  mutation (`addVectors`/`removeDocument`), and `clear()` behaviour, and that an ingest
  honors the picked `rag.embedProviderId`/`rag.embedModel`.
- The lock path has automated coverage: `src/rag/lifecycle.test.ts` proves the hydrate is
  aborted before the index is cleared, `src/rag/library-state.test.ts` proves `clear()`
  empties the list, and the browser checklist confirms that no decrypted title remains in
  the store or the UI after a lock.
- The manual checklist is recorded in this phase with a pass or a documented deviation for
  every line, including the production-CSP PDF load, the hostile-PDF case, the two-tab
  schema upgrade, the explicit embedding pick, and the 1,000-document / ~50,000-chunk scale
  measurement with its mode, dimensions, and memory budget.
- The citation card renders for `search_documents` and every other tool still renders
  through `ToolFallback`.
- `README.md` states what leaves the device, in which step, and why, including the pdf.js
  worker's same-origin egress without the document CSP.
- `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| The bypass class is mistaken for solved | The fixtures assert the recorded outcome, and the phase file and tool guide state that the filter is best-effort |
| A component test cannot run without jsdom and testing-library | Component behaviour is verified in the browser checklist; logic lives in the testable store |
| The pdf.js worker fails under the production CSP | Steps 9 through 16 run against the built bundle in preview, which applies the meta CSP |
| A hostile PDF drives the worker's network or storage access | The extraction caps bound the work before chunking, the vault key never enters the worker, and the checklist records the hostile-PDF case and any unexpected worker request |
| A large library makes ingest feel hung | Per-file progress, an abort path, and a list that shows the document only once its chunks are persisted |
| Citation rendering leaks passage text into the DOM unsafely | The card renders text nodes only, with no raw HTML insertion |
| Decrypted document titles survive a lock in the panel store | `useDocumentLibraryStore.clear()` runs in the `SessionProvider` cleanup next to the vector index clear, and the store test asserts it empties the list |
| The live vector index disagrees with the store after an add or a delete | `addFiles` calls `addVectors` after a successful ingest and `remove(id)` calls `removeDocument`, so a deleted document's vectors are evicted rather than scored |
| Two tabs on different schema versions both write | `db.close()` on `versionchange` and a surfaced "close other tabs" notice on `blocked`, verified by the two-tab checklist case |
| The scale measurement is taken on a fast machine and misleads | Record the machine, the document and chunk counts, the dimensions, the mode, and the memory budget alongside the timing |
| The user cannot tell which provider will receive their passages | The embedding provider selector and model input are explicit, default from the stored settings, persist on change, and the ingest error names the provider that failed |

## Security Considerations

The panel is the corpus owner's surface: only the user adds and removes documents, and no
tool can mutate the library. Ingest and retrieval both send data to remote services, which
the panel states next to the controls that trigger them. The panel also states the pdf.js
worker posture: raw PDF bytes reach a same-origin worker that does not inherit the document
CSP and can use the page's egress and IndexedDB, while the vault key never enters it. The
store keeps no plaintext corpus text in memory, its `clear()` runs in the session cleanup
so decrypted titles do not survive a lock, and the citation card renders decrypted passage
text only while the vault is unlocked. Removing a document deletes its chunks and evicts its
vectors from the live index, so a deleted file cannot be resurrected by a citation id.
Locking clears the vector index, and the generation guard makes a stale read fail rather
than serve.

## Next Steps

After this phase the plan's acceptance criteria are met or explicitly recorded as pending
with evidence. Remaining follow-ups belong to a later plan: non-English threshold
calibration on user data, `citationFuzzyMin` calibration against real claims, an ANN or
approximate index only if a future target exceeds 1,000 documents / ~50,000 chunks, and a
`plans/README.md` entry recording the plan's final status.
