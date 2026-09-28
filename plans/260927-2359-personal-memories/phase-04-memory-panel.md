---
phase: 4
title: Memory panel
status: completed
priority: P2
effort: 3h
dependencies: [1, 3]
---

# Phase 4 — Memory panel

## Goal

The user can see, add, edit, flag, and delete memories from a `Memory` rail panel.

## Files

- Create: `src/ui/panels/memory.tsx`
- Modify: `src/ui/shell.tsx`: add `"memory"` to `RailPanelId` and `RAIL_IDS`, and a panel entry after `documents` with the `Brain` icon.
- Tests: `src/ui/panels/memory.test.tsx`

## Steps

1. **Reading state.**
   - Read `useMemoryStore` for memories, scopes, and status.
   - Resolve the current folder's `scopeId` from `useWorkspaceStore` (`fs?.handle`) through `resolveScope`. Re-run it when `fs` changes.
2. **Grouping.**
   - **Global.**
   - **This workspace.** Shows the current scope, labelled with the folder name. It is hidden when no folder is granted.
   - **Other workspaces.** Every other scope, labelled by its stored name.
   - Rows are sorted newest first. An empty group shows a one-line empty state.
3. **Row.**
   - Shows the title, a `Pin` badge when important, a `model`/`user` source chip, and the relative update time.
   - Expanding a row shows the body, with Edit and Delete.
   - Delete asks for confirmation inline, matching the workspace tree's delete pattern.
4. **Edit and add form.**
   - Fields: title input, body textarea, important toggle, and a scope select. The scope select offers Global, plus This workspace when a folder is granted.
   - The form shows character counts against 120 and 2,000.
   - Save calls `create` or `update` with `source: 'user'`.
   - A `MemoryLimitError`, `MemoryConflictError`, or validation error is shown inline under the form.
5. **Status.**
   - `loading` shows a skeleton line.
   - `error` shows the message with a retry that calls `hydrate()`.
6. **Styling.** Follow the house primitives in `src/ui/primitives.tsx` and the structure of `library.tsx` / `skills.tsx`. Do not add new design tokens.

## Tests (intent)

- **Scope grouping.** With global, current-folder, and other-folder memories, each renders under its own group. The user must be able to tell what the current conversation sees.
- **No folder.** With no folder granted, the This workspace group and the workspace scope option are absent.
- **Budget error.** Saving an important memory past the budget shows the `memory_full` message and does not close the form.
- **Delete.** Confirming a delete removes the row through the store.
- **Source chip.** The chip shows `model` for tool-written memories, so the user can spot what the model saved on its own.

## Verification

- `pnpm exec vitest run src/ui/panels/memory.test.tsx`
- `pnpm exec tsc -b`
- `pnpm lint`
- Browser check (with the user's go-ahead):
  1. Ask the model to remember a preference.
  2. See it in the panel.
  3. Edit it.
  4. Start a new conversation and confirm the model uses it.
