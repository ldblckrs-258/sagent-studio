---
phase: 2
title: "Conversations and Workspace Grouping"
status: implemented (browser gate pending)
priority: P1
effort: "7h"
dependencies: [1]
---

# Phase 2: Conversations and Workspace Grouping

## Goal

Give the left column a real conversation list: create, switch, rename, and delete
threads over the encrypted store, grouped by the workspace folder name snapshotted
onto each thread, with a "No workspace" group for threads that have no snapshot.

## Context

- `ThreadSummary` is `{ id, updatedAt }` only (`src/chat/persistence.ts:10-13`);
  `listThreads()` returns raw rows without decrypting (`:90-93`). `ChatThread.title`
  exists (`src/chat/types.ts:28`) but is not in the summary, and there is no
  workspace field at all.
- `ThreadSummary` has more consumers than the summary line suggests: the
  `ThreadStore` interface (`src/chat/engine.ts:37`) and the test doubles
  `MemoryStore.listThreads` (`src/chat/engine.test.ts:137`, `:149`, `:173`) and
  the exact-shape assertion in `src/chat/persistence.test.ts:53-63` (including
  `Object.keys(list[0])`). All must be updated with the shape change
  (red-team finding 4).
- `saveThread` writes an encrypted envelope containing the whole thread
  (`src/chat/persistence.ts:69-76`); `createThread` is `validateThread` + `saveThread`
  (`:78-82`); `deleteThread` is queue-serialized (`:95-100`).
- The engine plan's acceptance criterion 7 requires a byte-scan test showing no
  plaintext message content or title in IndexedDB records
  (`../260919-0828-core-chat-engine/plan.md:100-102`). Titles therefore must never
  be written to a plaintext column.
- `validateThread` in `src/chat/persistence.ts:15-45` reconstructs the object field
  by field, so an optional field must be read explicitly or it is silently dropped
  on every load.
- Write-queue semantics: `loadThread` reads Dexie directly, outside
  `vaultWriteQueue`; only `saveThread`/`deleteThread` enqueue
  (`src/chat/persistence.ts:84-88`, `:69-76`, `:95-100`;
  `src/vault/write-queue.ts:10-14`). A load-then-save helper outside the queue can
  therefore overwrite a newer body or resurrect a deleted row (findings 8).
- The engine's `persist()` reads the thread from `useChatStore` and writes the
  whole object back (`src/chat/engine.ts:217-232`), so a rename that only touches
  Dexie is reverted by the next run unless the store is updated first.
- `defaultThreadConfig(providerId, modelId?)` requires a provider id
  (`src/chat/types.ts:38-47`), and `ThreadConfig.providerId` is validated non-empty
  (`:104-107`). Settings have no global default provider
  (`src/vault/settings.ts:30-37`).
- `useChatStore` exposes `setThread`, `removeThread`, `setActiveThread`, and
  `threads`/`activeThreadId` (`src/chat/store.ts:7-18`); `setActiveThread` does not
  load the thread.
- The vendored `thread-list.aui.tsx` groups by date and depends on the runtime
  thread-list adapter, which is absent; the app-owned list was the accepted
  decision (brainstorm §3, `brainstorm-260919-2129-…md:181-195`).
- Auto-titling was left unresolved by the brainstorm (`brainstorm-…md:244`) and is
  dropped by red-team scope finding: titles are manual only.
- `src/ui/primitives.tsx:68-94` `Row` and `:20-36` `Button` are the house
  structure for list rows and actions.

## Requirements

Functional:

- `ThreadSummary` becomes `{ id, title, workspaceName?: string, updatedAt }`,
  derived by decrypting each stored envelope inside `listThreads()`. No plaintext
  title column is introduced.
- `listThreads()` decrypts and parses per row inside a try/catch: a corrupt or
  undeserializable row is skipped and reported through an error marker, and a
  locked vault returns the locked state rather than rejecting the whole list
  (finding: one corrupt envelope must not hide the list).
- `renameThread(id, title)` and `setThreadWorkspaceLabel(id, workspaceName?)` exist
  and are single-owner writes: they update `useChatStore` first, then persist the
  same object. All read-modify-write happens inside one `vaultWriteQueue.enqueue`
  task, and the save is skipped when the row no longer exists (delete tombstone).
- `ChatThread` gains an optional `workspaceName?: string`; thread validation reads
  it back without an envelope version bump.
- `src/chat/threads.ts` provides the app-facing helpers: `createConversation`,
  `renameConversation`, `deleteConversation`, `labelConversation`,
  `defaultProviderFor(settings)`, and `groupConversations(summaries)`.
- The left panel lists workspace groups plus "No workspace", supports new /
  switch / rename / delete, shows a streaming badge for the streaming thread, and
  renders an empty state when no threads exist.
- Creating a thread uses `defaultProviderFor(settings)` — the first configured
  provider with its `defaultModel`. When no provider is configured the new-thread
  action is disabled with a hint pointing at the shell's Providers panel (mounted
  in Phase 1; relocated to a tab in Phase 4).
- Switching threads loads the thread into `useChatStore` and calls
  `useChatStore.setActiveThread(id)`; the Phase 1 engine map then resolves it.
- Titles are set by explicit rename only. A new thread gets a stable default title
  (`New chat`) and is never auto-renamed.

Non-functional:

- Grouping and the provider rule are pure functions so they are unit-testable
  under `environment: 'node'`.
- `listThreads()` decryption is bounded by the number of stored rows; the list is
  ordered by `updatedAt` descending from the Dexie index
  (`src/chat/persistence.ts:91`).
- No React and no `useChatStore` import in `src/chat/threads.ts`; store updates
  happen at the panel call sites.
- Threads created before a folder was picked stay in the "No workspace" group;
  picking a new folder only affects labels written after it (brainstorm §1).

## Architecture

```
src/chat/persistence.ts   ThreadSummary + per-row decryption; renameThread;
                          setThreadWorkspaceLabel (queue-internal patch)
src/chat/types.ts         ChatThread.workspaceName?; validation passthrough
src/chat/threads.ts       create, rename, delete, label, defaultProviderFor,
                          groupConversations (pure where possible)
src/ui/panels/conversations.tsx   grouped list UI mounted in the shell's left slot
src/ui/shell.tsx          mounts Conversations in the left column
```

Single-owner write path:

```
panel action (rename/label)
   -> useChatStore.setThread({ ...current, title })     // store first
   -> vaultWriteQueue.enqueue(async () => {
        row = await db.threads.get(id); if (!row) return   // delete tombstone
        await saveThread({ ...storeThread, title })         // persist same object
      })
```

The engine's next `persist()` reads the updated store, so the title survives.
Reading the row inside the queued task removes the load/save window that allowed
a delete to be overwritten (finding 8).

Grouping decision: `groupConversations` returns an array of
`{ workspaceName: string | null; threads: ThreadSummary[] }`, workspace groups
sorted alphabetically by `localeCompare` and the `null` group last, each group
ordered by `updatedAt` descending. `null` renders as "No workspace".

Backward compatibility: `workspaceName` is optional and additive. Existing
envelopes parse unchanged because `validateThread` reconstructs the object and
returns `workspaceName` only when it is a string; the envelope version stays
`1` (`src/chat/persistence.ts:8`). No migration runs, and a missing field is
indistinguishable from an old record, which is the intended tolerant read.

Provider rule: `defaultProviderFor(settings)` is defined once here and reused by
Phase 4. It returns `settings?.providers[0] ?? null`; order in the persisted array
is the only tie-break, so it is deterministic and testable.

## Files to Create / Modify

- Modify: `src/chat/persistence.ts` (`ThreadSummary`, per-row decrypted
  `listThreads`, `renameThread`, `setThreadWorkspaceLabel`, `validateThread`
  passthrough)
- Modify: `src/chat/types.ts` (`ChatThread.workspaceName?`)
- Modify: `src/chat/engine.test.ts` (`MemoryStore.listThreads` summary shape)
- Modify: `src/chat/persistence.test.ts` (rewrite the exact-shape assertion for
  the new summary, add title/label/byte-scan/per-row-tolerance tests)
- Create: `src/chat/threads.ts`
- Create: `src/chat/threads.test.ts`
- Create: `src/ui/panels/conversations.tsx`
- Modify: `src/ui/shell.tsx` (mount the left panel)

## Implementation Steps

1. Add `workspaceName?: string` to `ChatThread` in `src/chat/types.ts:26-33`.
2. Extend `validateThread` in `src/chat/persistence.ts`: if
   `candidate.workspaceName` is a string, include it; otherwise omit it. Do not
   bump `THREAD_ENVELOPE_VERSION`.
3. Change `listThreads()` to load each row, decrypt it with
   `decryptRecord(row.blob, 'thread:' + row.id)`, parse the envelope, and return
   `{ id, title, workspaceName, updatedAt }`. Wrap each row in try/catch: collect
   a failure count/marker instead of rejecting, and return an empty list rather
   than throwing when the vault is locked. Keep the `updatedAt desc` ordering.
4. Add `renameThread(id, title)` and `setThreadWorkspaceLabel(id, workspaceName?)`.
   Each enqueues one task that re-reads `db.threads.get(id)`, returns without
   writing when the row is gone (tombstone), loads the current thread, patches the
   field, and calls `saveThread` with a fresh `updatedAt`. Title must be a string;
   a title longer than the UI limit is truncated by the caller, not silently here.
5. Update `src/chat/engine.test.ts` `MemoryStore.listThreads` to return the new
   summary shape, and rewrite the exact-shape assertion in
   `src/chat/persistence.test.ts:53-63` (including `Object.keys`) instead of
   extending it.
6. Add `src/chat/threads.ts`: `defaultProviderFor(settings)`,
   `createConversation({ title?, config, workspaceName? })` returning a saved
   `ChatThread`, `renameConversation`, `deleteConversation` (delegates to
   `deleteThread`), `labelConversation`, and `groupConversations`. Keep it free of
   React; expose the store-syncing call sites for the panel.
7. Write `src/chat/threads.test.ts` under `fake-indexeddb`: create + list round
   trip returns the title and workspace label; a store-first rename survives a
   simulated engine `persist`; rename/label against a deleted row does not
   resurrect it; delete removes the row; `groupConversations` puts alphabetized
   workspace groups first and the `null` group last; `defaultProviderFor` returns
   the first provider and `null` when empty.
8. Extend `src/chat/persistence.test.ts` with: a byte-scan test that saves a
   thread whose title and `workspaceName` are unique sentinel strings, reads the
   raw `db.threads` row, and asserts the **ciphertext** `row.blob` bytes do not
   contain either sentinel (do not assert on decrypted bytes); a per-row tolerance
   test where one corrupt row plus two valid rows still lists the two valid rows;
   and an envelope without `workspaceName` still loading.
9. Add `src/ui/panels/conversations.tsx`: read `listThreads()` on mount and after
   every mutation; subscribe to `useChatStore` for `activeThreadId`, `activeRuns`,
   and the failure marker. Render group headers with `.label-micro`, thread rows
   as keyboard-accessible buttons, a streaming badge when `activeRuns > 0` and
   the row is active, inline rename (input + save/cancel), and a delete that
   requires confirmation. Use `Button`, `Input`, and `Row` from
   `src/ui/primitives.tsx`. Disable New when no provider is configured and show a
   hint that activates the Providers panel.
10. Wire the panel actions in the single-owner order: rename/label update
    `useChatStore.setThread` first, then call the persistence helper; delete calls
    `deleteConversation(id)`, `useChatStore.removeThread(id)`, and
    `session.disposeThread(id)`; create calls `createConversation`, `setThread`,
    `setActiveThread`; switch does `await loadThread(id)`, `setThread`,
    `setActiveThread`.
11. Label a thread at creation with the current workspace folder name when one is
    available (`session.getWorkspace()?.handle.name`). Do not relabel on later
    turns.
12. Mount `Conversations` in the shell's left slot in `src/ui/shell.tsx`.
13. `pnpm test`, `pnpm lint`, `pnpm build`.
14. Browser gate: create, switch, rename, delete; reload and confirm persistence;
    send a message after a rename and confirm the title survives the engine
    persist; confirm grouping labels and the "No workspace" group; confirm the
    streaming badge. Record in the journal.

## Todo

- [ ] `ThreadSummary` carries title + optional workspace label, decrypted per row
- [ ] `renameThread` + `setThreadWorkspaceLabel` (queue-internal, tombstone-guarded)
- [ ] `ChatThread.workspaceName?` with tolerant validation, no version bump
- [ ] `src/chat/threads.ts` + pure grouping/provider helpers
- [ ] `threads.test.ts`; `persistence.test.ts` exact-shape rewrite + byte scan + tolerance
- [ ] `engine.test.ts` MemoryStore summary shape updated
- [ ] `src/ui/panels/conversations.tsx` grouped list (manual rename only)
- [ ] shell mounts the left panel
- [ ] browser gate recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/chat` passes, including grouping, store-first rename surviving
  a persist, delete-race non-resurrection, per-row envelope tolerance, and the
  ciphertext byte scan.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean; `engine.test.ts` and `persistence.test.ts`
  compile against the new `ThreadSummary`.
- Byte-scan gate: raw `db.threads` `row.blob` contains neither the sentinel title
  nor the sentinel workspace label.
- Browser gate recorded in the journal: create/switch/rename/delete survive
  reload; a rename survives a following message; groups render correctly;
  deleting the active thread returns the center column to the empty state.

## Success Criteria

- [ ] Acceptance criterion 1 is demonstrated: grouped conversations plus
      create/switch/rename/delete surviving reload.
- [ ] No plaintext title or workspace label is stored.
- [ ] A rename survives the next engine run, and a delete is never resurrected by
      a pending rename/label write.
- [ ] One corrupt thread row does not hide the rest of the list.
- [ ] The "No workspace" group holds exactly the threads with no snapshot.
- [ ] Switching threads loads via the encrypted store, not from a stale runtime
      repository.
- [ ] `defaultProviderFor` is defined once and returns the first provider.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| `validateThread` drops `workspaceName` on load | Label disappears after reload | Read the optional field explicitly and test the round trip. |
| Rename touches only Dexie | Title reverts after the next run | Update `useChatStore` first, then persist the same object; test with a simulated `persist`. |
| Load/save window lets a delete be overwritten | Deleted thread reappears | Re-read the row inside the queued task and skip the save when it is gone. |
| `ThreadSummary` shape change breaks consumers | `pnpm build`/`pnpm test` fails | Update `engine.test.ts` and rewrite the `persistence.test.ts` exact-shape assertion in this phase. |
| Titles are written plaintext for list performance | Byte scan finds a title | Decrypt in `listThreads`; cache summaries in memory only if needed. |
| One corrupt row rejects the list | Sidebar empty while threads exist | Per-row try/catch with a failure marker; unit test with a corrupt row. |
| Grouping order is nondeterministic | Groups shuffle between renders | Group by `localeCompare`, sort each group by `updatedAt` desc, and unit-test the order. |
| New thread cannot be created with no provider | New button appears to do nothing | Disable New with a hint that activates the Providers panel (Phase 1 mount). |

## Security Considerations

- Thread titles and labels are user content and stay inside the encrypted
  envelope; no plaintext column, index, or log line carries them.
- `listThreads` decrypts with `decryptRecord`, which fails closed when the vault
  is locked (`src/vault/records.ts`); the locked case renders the locked state and
  never throws into the shell.
- Delete confirmation prevents accidental loss; deletion needs no key and stays
  queue-serialized; a pending rename cannot recreate a deleted row.
- No new external call is introduced; grouping is entirely local.

## Next Steps

Phase 3 fills the workspace panel and browser. It reuses `session.getWorkspace()`
for the folder name that Phase 2 snapshots as the label. Phase 4 reuses
`defaultProviderFor` for the Thread tab default.
