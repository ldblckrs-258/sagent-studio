---
phase: 3
title: "Workspace Browser and File Editor"
status: implemented (browser gate pending)
priority: P1
effort: "10h"
dependencies: [1]
---

# Phase 3: Workspace Browser and File Editor

## Goal

Add the workspace picker with permission re-grant, a lazy directory tree, and a
plain text file viewer/editor with dirty tracking and save, all driven by the live
`WorkspaceFs` the session holds.

## Context

- The persisted handle lives at a single record, `db.fs` id `'workspace'`
  (`src/workspace/handle.ts:6`, `:12-18`). `isPickerAvailable` checks
  `window.showDirectoryPicker` (`:8-10`); `restoreWorkspace` returns a fresh
  `WorkspaceFs` or `null` (`:20-24`).
- `WorkspaceFs.list(path)` returns one level, already sorted by name
  (`src/workspace/fs.ts:129-145`); there is no recursive or tree helper.
- `WorkspaceFs.readFile` rejects files over the 2 MB cap and re-checks the byte
  length after decoding (`src/workspace/fs.ts:147-155`); `writeFile` enforces the
  cap before writing and creates parents (`:157-172`).
- Permission failures map to `WorkspacePermissionError`; path problems to
  `WorkspacePathError`; missing entries to `WorkspaceNotFoundError`; oversized
  files to `WorkspaceLimitError` (`src/workspace/errors.ts:8-41`).
- `ensurePermission` queries then requests (`src/workspace/fs.ts:57-71`). A
  re-grant needs a user gesture, so `showDirectoryPicker` and re-grant are
  browser-only and already deferred in the predecessor plan
  (`../260919-0828-core-chat-engine/plan.md:180-183`).
- The session exposes `getWorkspace()`/`setWorkspace()` in Phase 1 by delegating to
  this store, so the store is the single owner of the live `WorkspaceFs` and there
  is no second holder (red-team finding 10). The engine reads the same instance
  through the session getter.
- The file editor uses **Monaco** (user decision, Validation Session 1). It must
  be bundled locally rather than loaded from a CDN because the build CSP is
  `script-src 'self'` (`vite.config.ts:23`), and its editor worker must be emitted
  by Vite so `worker-src 'self'` (`vite.config.ts:24`) covers it. This supersedes
  the earlier plain-textarea decision.
- `WorkspaceApi` (`src/tools/types.ts:19-26`) is the structural interface the
  same `WorkspaceFs` satisfies; the tools panel and skills panel consume the same
  instance.

## Requirements

Functional:

- `src/workspace/tree.ts` provides a pure, one-level-`list()`-driven tree:
  `buildTreeEntries(entries, parentPath)` and a flatten helper that renders only
  expanded nodes, keeping the WorkspaceFs calls lazy.
- `src/session/workspace-state.ts` provides a subscribable store for the live
  workspace: `{ fs, folderName, status: 'none' | 'ready' | 'denied' | 'unsupported', error }`
  plus `pick()`, `restore()`, `regrant()`, `markDenied()`, and `clear()`.
- `restore()` must not assume permission survived the reload: it queries
  `fs.ensurePermission('read')`-equivalent permission state (query-only, no
  request) and enters `status: 'denied'` when permission is not granted, so the
  actionable "Grant access" state is reachable from a gesture instead of failing
  on the first tree fetch (red-team finding 23).
- `clear()` resets only the in-memory reference on lock. It must **never** call
  `clearWorkspaceHandle()`; the persisted handle is the deliberate reload
  convenience and deleting it would break acceptance criterion 5
  (red-team finding 10).
- The picker button is feature-detected with `isPickerAvailable()`; when
  unavailable the panel shows `WorkspaceUnsupportedError`'s message and disables
  picking.
- A denied or missing permission shows an actionable state with a "Grant access"
  button that calls `ensurePermission('readwrite')` from a user gesture.
- The browser renders a tree with expand/collapse per directory, a refresh
  action, and a per-entry "open" action for files.
- `src/ui/panels/file-editor.tsx` opens a file with `readFile`, renders it in a
  Monaco editor, tracks dirty state against the loaded content, offers save and
  cancel, saves with `writeFile`, and maps errors to messages.
- Monaco is lazy-loaded (dynamic import) so the chat surface is not blocked by the
  editor bundle; a plain mono fallback renders while the editor chunk loads and if
  the Monaco worker cannot start, so the file is never unreachable.
- `WorkspaceLimitError`, `WorkspacePermissionError`, and `WorkspacePathError`
  each render a distinct, readable message; save is disabled when not dirty.

Non-functional:

- Tree assembly and flattening are pure and unit-testable in node.
- The editor is a controlled Monaco instance with the house mono palette and no
  binary handling; the fallback path stays a plain textarea so a worker failure
  degrades instead of blocking.
- Save is explicit; there is no autosave and no silent overwrite of an external
  change.
- Panels reuse `Row`, `Field`, `Button`, and `Input` from `src/ui/primitives.tsx`
  and the `panel-in` motion for panel entry.
- The panel never renders a raw `DOMException`; it maps to the typed errors.

## Architecture

```
src/workspace/tree.ts              pure tree + flatten helpers
src/session/workspace-state.ts     subscribable live WorkspaceFs store
src/ui/panels/workspace.tsx        picker, re-grant, tree
src/ui/panels/file-editor.tsx      Monaco editor wrapper, dirty tracking, save/cancel
src/ui/monaco-editor.tsx           lazy Monaco loader + house theme + fallback
src/ui/shell.tsx                   mounts both panels in the rail
src/session/session-provider.tsx   writes restored/picked fs into workspace-state
```

Tree helper contract:

```ts
type TreeNode = {
  name: string
  path: string
  kind: 'file' | 'directory'
}

buildTreeEntries(entries: WorkspaceEntry[], parentPath: string): TreeNode[]
flattenTree(nodes: TreeNode[], childrenByPath: Map<string, TreeNode[]>,
            expanded: ReadonlySet<string>, depth?: number): Array<TreeNode & { depth: number }>
```

`flattenTree` is the only render-facing function, so lazy loading stays in the
panel: expanding a directory calls `fs.list(path)` once and stores the result in
`childrenByPath`.

Workspace state:

```ts
interface WorkspaceState {
  fs: WorkspaceFs | null
  folderName: string | null
  status: 'none' | 'ready' | 'denied' | 'unsupported'
  error: string | null
  pick(): Promise<void>
  restore(): Promise<void>
  regrant(): Promise<void>
  markDenied(): void
  clear(): Promise<void>
}
```

This store is the single owner of the live handle. `SessionProvider` constructs
it, calls `restore()` on unlock and `clear()` on lock, and Phase 1's session
`getWorkspace()`/`setWorkspace()` delegate to it rather than holding a parallel
slot (red-team finding 10). `clear()` nulls `fs`/`folderName` in memory only and
never touches `db.fs`.

Editor data flow:

```
open(path) -> fs.readFile(path) -> { path, saved, draft: saved, dirty: false }
onChange   -> draft, dirty = draft !== saved
save()     -> fs.writeFile(path, draft) -> saved = draft, dirty = false
cancel()   -> draft = saved, dirty = false
error      -> typed message; draft retained so the user does not lose text
```

Monaco wiring: `src/ui/monaco-editor.tsx` dynamically imports `monaco-editor`,
configures a light/dark theme from the house tokens, and passes
`language`/`value`/`onChange` to the panel. The editor worker is loaded through
Vite's `?worker` import so it is emitted as a same-origin chunk and covered by
`worker-src 'self'`. The wrapper renders a plain mono textarea until the chunk
resolves and keeps that textarea as the fallback if the worker fails.

## Files to Create / Modify

- Create: `src/workspace/tree.ts`
- Create: `src/workspace/tree.test.ts`
- Create: `src/session/workspace-state.ts`
- Create: `src/session/workspace-state.test.ts` (pure state transitions with a
  fake `WorkspaceFs`)
- Create: `src/ui/panels/workspace.tsx`
- Create: `src/ui/panels/file-editor.tsx`
- Create: `src/ui/monaco-editor.tsx` (lazy loader, house theme, textarea fallback)
- Modify: `package.json` + `pnpm-lock.yaml` (add `monaco-editor`)
- Modify: `src/session/session-provider.tsx` (write restore/pick/clear into the
  store)
- Modify: `src/ui/shell.tsx` (mount both panels)

## Implementation Steps

1. Add `src/workspace/tree.ts` with `buildTreeEntries` and `flattenTree` as pure
   functions over `WorkspaceEntry[]` (`src/tools/types.ts:6-11`). Sort
   directories before files at the same level using `localeCompare`, matching the
   existing `list` ordering assumption.
2. Write `src/workspace/tree.test.ts`: empty input; files only; nested depth
   flattening; collapsed directories excluded; deterministic directory-first
   ordering; depth values.
3. Add `src/session/workspace-state.ts` as a small Zustand store (the project
   already depends on `zustand`, `package.json:41`). `pick()` calls
   `pickWorkspace` and records the folder name from `fs.handle.name`; `restore()`
   calls `restoreWorkspace`, sets `status: 'none'` when it returns `null`, and
   otherwise queries permission and sets `status: 'ready'` only when granted, or
   `status: 'denied'` when not; `regrant()` calls `fs.ensurePermission('readwrite')`
   from the user gesture and maps `WorkspacePermissionError` to `status: 'denied'`;
   `markDenied()` exists so a failed tree/read operation can flip the state;
   `clear()` resets the in-memory fields only. Map `WorkspaceUnsupportedError` to
   `status: 'unsupported'`.
4. Write `src/session/workspace-state.test.ts` with an injected fake `WorkspaceFs`
   and a stub picker: pick success, pick denied, restore null, restore with
   permission denied entering `denied`, regrant success, regrant denied,
   `markDenied`, and `clear` nulling the reference without deleting `db.fs`. Keep
   the picker injectable so no browser API is needed in node.
5. Wire `SessionProvider` to construct the store, call `restore()` after unlock
   and `clear()` on dispose, and have Phase 1's session `getWorkspace()`/
   `setWorkspace()` delegate to the store so the engine and the panels share the
   same `WorkspaceFs` instance.
6. Add `src/ui/panels/workspace.tsx`: a `Row` with the folder name and a
   "Choose folder" button guarded by `isPickerAvailable()`; a denied state with a
   "Grant access" button; a refresh button; and the tree. Directory rows toggle
   expansion and lazily fetch children via `fs.list`; file rows call the editor's
   open action. Map every caught error through the typed workspace errors and
   render `role="alert"` text.
7. Add `src/ui/monaco-editor.tsx` and `src/ui/panels/file-editor.tsx`. The wrapper
   dynamically imports `monaco-editor`, registers a light and dark theme from the
   house palette, imports the editor worker via a Vite `?worker` module, and
   renders the textarea fallback until readiness or on failure. The panel takes
   props `{ fs, path, onClose }`: load with `readFile`; render the editor sized to
   the panel (not the 44rem thread width); show the dirty indicator, Save
   (disabled when clean), and Cancel. On save call `writeFile` and reset the
   baseline; on error keep the draft and show the mapped message. Include the
   byte-size hint against `DEFAULT_SIZE_CAP` (`src/workspace/fs.ts:24`) so the
   limit is visible before a failed save.
8. Mount `Workspace` and `FileEditor` in the shell rail in `src/ui/shell.tsx`.
   Opening a file from the tree switches the active panel to the editor.
9. `pnpm test`, `pnpm lint`, `pnpm build`.
10. Browser gate: pick a folder; reload and observe the permission state; grant
    access; expand directories; open a file; edit and save; confirm the file
    changed on disk; open a file above 2 MB and confirm the limit message; deny
    the re-grant and confirm the actionable state; confirm the Monaco editor loaded
    under the build CSP with no console violation and that its worker started (the
    textarea fallback must not be what rendered); record the bundle-size delta for
    the editor chunk. Record all of it in the journal.

## Todo

- [ ] `src/workspace/tree.ts` + pure tests
- [ ] `src/session/workspace-state.ts` + injectable-picker tests
- [ ] `SessionProvider` wires restore/pick/clear
- [ ] `src/ui/panels/workspace.tsx` (picker, re-grant, tree)
- [ ] `monaco-editor` added; `src/ui/monaco-editor.tsx` lazy loader + theme + fallback
- [ ] `src/ui/panels/file-editor.tsx` (dirty, save, cancel, error mapping)
- [ ] shell mounts both panels
- [ ] Monaco CSP/worker browser check + bundle-size note recorded
- [ ] browser gate recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/workspace src/session` passes.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean.
- Server-render smoke: if `FileEditor`'s static error/empty states can be
  extracted into a hook-free presentational component, add a
  `renderToStaticMarkup` assertion; otherwise state in the journal that the
  editor is browser-verified only. Do not claim interaction coverage in node.
- Browser gate recorded in the journal: pick, reload, re-grant, denied state,
  tree expand, open, dirty, save, size-cap error, Monaco load under the build CSP
  with its worker running, and the editor chunk size delta.

## Success Criteria

- [ ] Acceptance criterion 5: pick, re-grant after reload, and an actionable
      denied state.
- [ ] Acceptance criterion 6: tree listing, open, dirty tracking, and save
      through `WorkspaceFs.writeFile`.
- [ ] Tree loading is lazy; expanding a large folder does not read the whole
      subtree.
- [ ] Every workspace error is mapped to a readable, typed message; no raw
      `DOMException` reaches the user.
- [ ] The editor never writes binary or over-cap content; the cap is visible
      before a failed save.
- [ ] Monaco loads from local assets only, its worker starts under `worker-src
      'self'`, and the chat surface is not blocked by its chunk.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| `showDirectoryPicker` cannot be driven headlessly | Browser gate cannot complete the pick step | Accept as a browser journal gate, as the predecessor plan already does; unit coverage uses `fake-handle` (`src/workspace/fake-handle.ts`). |
| Permission is lost after reload and the panel looks broken | Tree fetch throws permission errors | `restore()` queries permission and enters `denied` before the first fetch; a gesture-backed Grant button is the only way out (`markDenied` for later failures). |
| Monaco violates the build CSP or its worker cannot load | Editor blank in `vite preview`; CSP violation logged | Bundle locally (no CDN), emit the worker through Vite, verify in the Phase 3 browser gate; degrade to the textarea fallback if the worker never starts. |
| Monaco inflates the bundle or blocks first paint | Slow first load; large editor chunk | Lazy-load via dynamic import, render the textarea until ready, and record the size delta. |
| Recursive tree building loads an enormous folder | UI hangs on expand | Fetch one level per expansion via `fs.list`; never walk recursively on mount. |
| Unsaved edits are lost on panel close or thread switch | User loses text silently | `cancel` resets to baseline only on explicit user action; panel close with `dirty` prompts for confirmation. |
| Save races an external change | User overwrites a file changed outside the app | Accept for this phase (no watcher exists); the explicit Save plus the byte-size hint is the boundary, and the limitation is stated in the journal. |
| A typed error is swallowed and only logged | Silent no-op on save | Every catch maps to a rendered `role="alert"` message. |

## Security Considerations

- All reads and writes go through `WorkspaceFs`, which re-checks permission per
  operation and rejects traversal, absolute paths, backslashes, and drive/UNC
  prefixes (`src/workspace/fs.ts:30-41`, `:103`).
- The panel never calls the File System Access API directly; it only uses the
  typed `WorkspaceFs` methods, so path validation cannot be bypassed by the UI.
- The live handle reference is dropped on vault lock; the panel renders a
  locked/empty state. The underlying FileSystemDirectoryHandle remains
  deliberately persisted at db.fs id 'workspace' (src/workspace/handle.ts:12-24);
  permission re-grant, not the lock, is the real gate, and clear() must not delete
  it (red-team finding 28).
- File content is edited as plain text in Monaco and is never interpreted as HTML;
  Monaco is bundled locally so no third-party script is loaded at runtime.
- No file content or path is logged to the console or sent anywhere.

## Next Steps

Phase 4 adds the tabbed config panel. Its Vault tab relocates `StorageWarning`
and `DataEgressNotice` out of the center column that Phase 1 kept them in.
