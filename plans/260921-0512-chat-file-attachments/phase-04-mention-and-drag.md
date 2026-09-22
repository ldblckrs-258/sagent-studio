---
phase: 4
title: "Phase 4: @ mention and tree drag"
status: completed
priority: P1
effort: "6h"
dependencies: [2, 3]
---

# Phase 4: @ mention and tree drag

## Goal

Attach a workspace path by typing `@` in the composer, or by dragging a row out of the workspace tree.

## Context

The caret is the deciding constraint. The slash popover needs none, because `/` sits at index 0 and it reads `s.composer.text` alone (`src/ui/slash-suggestions.tsx:49`). A mention can appear anywhere, and composer state never publishes the caret: `ComposerInput` hands `selectionStart` only to the plugin registry (`ComposerInput.tsx:381-386`, `:415-426`). `aui.composer.setText` also moves a controlled textarea's caret to the end.

The installed `@assistant-ui/react@0.15.20` ships `unstable_useMentionAdapter` with an `items`/`search` adapter, a directive formatter, and an `onInserted` callback, and it exports `ComposerPrimitive.Unstable_TriggerPopover`. That companion was missing when the slash popover was hand-rolled, which is why that decision does not carry over automatically.

`fs.search` matches file **content**, never names (`src/workspace/search.ts:160-171`), and compiles its pattern as a live RegExp (`:104`), so it is the wrong tool for path completion. `fs.list` already compiles a glob against the path (`src/workspace/fs.ts:218-219`) and caps recursive listings at 1000 entries (`:68`), with no exclusion list of its own — unlike search's `DEFAULT_EXCLUDED_DIRS` (`src/workspace/search.ts:17-25`).

## Files to Create / Modify

- Create: `src/ui/mention-index.ts`
- Create: `src/ui/mention-index.test.ts`
- Create: `src/ui/mention-suggestions.tsx`
- Modify: `src/ui/panels/workspace.tsx`
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`

## Implementation Steps

1. **Spike first, time-boxed.** Render `ComposerPrimitive.Unstable_TriggerPopover` with `unstable_useMentionAdapter` against the external-store runtime and confirm three things: the popover opens on `@` mid-text, `onInserted` fires with the chosen item, and the inserted directive text survives `extractText` on send. Record the outcome in this file before continuing. If any check fails, build the hand-rolled popover instead: wrapper-level `onKeyUp`/`onInput`/`onSelect` reading `event.currentTarget.selectionStart`, a `mentionQueryAt(text, caret)` helper in a sibling `mention-suggestions-state.ts` with its own test file, and an explicit caret restore after `setText`.
2. In `src/ui/mention-index.ts`, build the index from `fs.list('', { recursive: true })`, filtered to exclude `DEFAULT_EXCLUDED_DIRS`, any dot-directory, and every deny-listed basename from `src/chat/attachments.ts`. Cache `{ source: fs, entries, truncated }` per `WorkspaceFs` instance, as `workspace-tree-state.ts` does, and export `invalidate()` for the workspace refresh button.
3. Add `rankEntries(entries, query, limit = 20)`: case-insensitive, preferring a basename prefix match, then a path prefix match, then a subsequence match, then shorter paths. An empty query returns the first `limit` entries in tree order.
4. When the query finds nothing and the index is truncated, re-query `fs.list('', { recursive: true, glob: '**/*' + query + '*', maxEntries: 50 })` rather than `fs.search`, which cannot match names. Debounce that call and never issue it per keystroke.
5. Wire the popover: each row shows the file icon, the basename, and the dimmed parent path, and the footer states when the index is capped at 1000 entries. Selecting an entry calls `add(threadId, { kind: entry.kind === 'directory' ? 'folder' : 'file', path: entry.path, source: 'mention', bytes: entry.size })`. With the adapter path, the inserted `@path` text stays in the message and the chip carries the payload; say so in the footer so the two are not read as duplicates.
6. Gate the mention popover on the slash popover being closed, since a slash command occupies the start of the text.
7. In `src/ui/panels/workspace.tsx`, mark each tree row `draggable`, and on `dragstart` set `application/x-sagent-path` to the node path and `application/x-sagent-token` to the session token from `src/ui/composer-dropzone.tsx`, with `effectAllowed = 'copy'`. Do not set a `text/plain` path payload, because the dropzone must never treat plain text as a path. The existing `onClick` stays; the browser's drag threshold keeps a drag from opening the file.

## Spike outcome

The spike could not be run: this execution was explicitly instructed to make no
browser check, and the three checks it defines (popover opens on `@` mid-text,
`onInserted` fires, the inserted directive survives `extractText`) are all
runtime observations. The adapter was read instead, and rejected on evidence:

- `unstable_useMentionAdapter` builds one static pool and exposes a
  **synchronous** `search(query)`. This index is loaded from `fs.list`, capped
  at 1000 entries, and needs a debounced glob re-query for anything past the
  cap, none of which fits that contract.
- The adapter's own entry points are marked `@deprecated — under active
  development and might change without notice`.
- `ComposerPrimitive` in 0.15.20 exports the trigger popover's hooks under
  `unstable_*` names; the plan's named `Unstable_TriggerPopover` component was
  not confirmed on the primitive namespace.

The drafted fallback was therefore built: a hand-rolled popover mirroring the
proven `SlashSuggestions` pattern, with `mentionQueryAt` and `completeMention`
in `src/ui/mention-suggestions-state.ts` and their own test file, wrapper-level
caret tracking, and an explicit caret restore after `setText`.

## Verification

- `pnpm exec vitest run src/ui/mention-index.test.ts`
- `pnpm exec vitest run src/ui`
- `pnpm lint && pnpm build`
- Manual, in the browser: `@` mid-sentence, then drag one file and one folder from the tree.

## Success Criteria

- [x] The spike's outcome and the chosen `@` implementation are recorded in this file before the rest of the phase is built.
- [x] `@` after whitespace opens the popover mid-message; `a@b` does not.
- [x] `@eng` ranks `src/chat/engine.ts` above a deeper path that merely contains the letters.
- [x] Completing an entry adds a chip and leaves the caret where the user was typing, not at the end of the text.
- [x] Escape closes the popover and leaves the typed text alone.
- [x] A slash command at the start of the text keeps the mention popover closed.
- [x] The index omits `node_modules`, dot-directories, and `.env`, and a repository with a large `node_modules` still offers `src/` paths.
- [x] The glob fallback finds a file outside the first 1000 entries, and the footer states the cap.
- [x] Dragging a tree file adds a file chip and a directory adds a folder chip, without opening either in the File panel.
- [x] A drag payload without the session token is rejected by the dropzone.

The two manual browser checks (`@` mid-sentence, dragging a file and a folder)
were skipped at the user's instruction. Their logic is covered by
`mention-suggestions-state.test.ts` and `composer-upload.test.ts`, but the
rendered popover and a real `DataTransfer` drag remain unverified.

## Deviations

| Drafted | Built | Why |
|---|---|---|
| `@` completion via `unstable_useMentionAdapter` | Hand-rolled popover (the drafted fallback) | See Spike outcome. |
| `mention-suggestions.tsx` alone | Plus `mention-suggestions-state.ts` and its test | The fallback path the plan specifies. |
| Completion always appends a trailing space | Appends one only when the text does not already continue with whitespace | Otherwise completing mid-sentence leaves a double space. |
