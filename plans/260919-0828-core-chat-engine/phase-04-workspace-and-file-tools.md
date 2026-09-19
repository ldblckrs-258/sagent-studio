---
phase: 4
title: "Workspace and File Tools"
status: done
priority: P1
effort: "8h"
dependencies: [2, 3]
---

# Phase 4: Workspace and File Tools

## Goal

Let the user grant a local folder, persist the handle across reload, and expose
path-safe list/read/write/remove system tools plus a workspace skill source. The
persisted handle and sandbox reach are an explicitly accepted residual risk.

## Context

- File System Access API is Chromium-only; permission is not persisted and must be
  re-requested from a user gesture each session
  (`reports/researcher-01-browser-runtime.md:16-89`).
- A `FileSystemDirectoryHandle` is structured-cloneable and can be stored in
  IndexedDB (`researcher-01:60-62`). A same-origin worker can read any IndexedDB
  (`researcher-01:218`), so the persisted handle is reachable by sandbox code.
  This is the user's accepted decision (Validation Session 1, decision 2).
- `navigator.storage.persist()` is independent of folder permission
  (`researcher-01:248-256`).
- The tool registry and `CodeRunner` port come from Phase 3 and Phase 1; Dexie is
  at version 3 after Phase 3.

## Requirements

Functional:

- `pickWorkspace()` opens the directory picker from a user gesture, persists the
  handle in a dedicated Dexie `fs` table, and returns a `WorkspaceFs`.
- `restoreWorkspace()` reads the persisted handle and returns a `WorkspaceFs`;
  permission is re-requested from a gesture before use.
- `WorkspaceFs.ensurePermission(mode)` calls `queryPermission` then
  `requestPermission` (main thread only) and is re-checked before every operation.
- Operations: `list`, `readFile` (text, size cap), `writeFile`, `makeDir`,
  `remove`, `stat`.
- System tools: `list_dir`, `read_file`, `write_file`, `make_dir`, `remove`.
- A workspace `SkillSource` that loads `.agents/skills/**/SKILL.md` with
  `source: 'workspace'`.
- `WorkspaceUnsupportedError` when the picker is unavailable; other failures map
  to typed errors.

Non-functional:

- Path resolution rejects absolute paths, `..`/`.` segments, backslashes, drive
  letters, UNC prefixes, and null bytes.
- Read/write size caps (default 2 MiB).
- Permission is re-checked per operation; a revoked grant yields
  `WorkspacePermissionError`, not an untyped DOMException.

## Architecture

```
src/workspace/errors.ts      typed workspace errors
src/workspace/handle.ts      pickWorkspace, restoreWorkspace, ensurePermission,
                             isPickerAvailable
src/workspace/fs.ts          WorkspaceFs over FileSystemDirectoryHandle
src/workspace/fake-handle.ts test-only in-memory handle factory
src/tools/builtin/workspace.ts  workspaceToolProvider (ToolProvider)
src/skills/workspace-source.ts  workspaceSkillSource (SkillSource)
```

Dexie `version(4)` adds `fs: 'id'` with
`FsHandleRecord { id: 'workspace'; handle: FileSystemDirectoryHandle; updatedAt: number }`.
The handle is stored raw because it is a structured-clone object, not JSON.

> Accepted residual risk: sandbox code can read this record and use the handle,
> bypassing `WorkspaceFs`. Main-thread tools still validate paths and permission.
> This is recorded in `plan.md` Key Decisions and the Validation Log.

Path resolution:

```ts
const SEGMENT = /^[^<>:"|?*\0\\/]+$/   // no separators, no Windows-reserved chars
function resolveSegments(path: string): string[] {
  if (path.includes('\0')) throw new WorkspacePathError(path)
  if (path.startsWith('/') || path.startsWith('\\')) throw new WorkspacePathError(path)
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('\\\\')) throw new WorkspacePathError(path)
  const segments = path.split('/').filter((s) => s !== '')
  for (const s of segments) {
    if (s === '.' || s === '..' || !SEGMENT.test(s)) throw new WorkspacePathError(path)
  }
  return segments
}
```

## Files to Create / Modify

- Create: `src/workspace/errors.ts`
- Create: `src/workspace/handle.ts`
- Create: `src/workspace/fs.ts`
- Create: `src/workspace/fs.test.ts`
- Create: `src/workspace/fake-handle.ts`
- Create: `src/tools/builtin/workspace.ts`
- Create: `src/tools/builtin/workspace.test.ts`
- Create: `src/skills/workspace-source.ts`
- Modify: `src/vault/db.ts` (version 4: `fs` table + `FsHandleRecord`)

## Implementation Steps

1. Add `src/workspace/errors.ts` with `WorkspaceUnsupportedError`,
   `WorkspacePermissionError`, `WorkspacePathError`, `WorkspaceNotFoundError`,
   `WorkspaceLimitError`.
2. Add `src/workspace/handle.ts`: `isPickerAvailable`, `pickWorkspace` (pick with
   `{ mode: 'readwrite' }`, `db.fs.put`), `restoreWorkspace` (read the record and
   wrap), `clearWorkspaceHandle`, and `ensurePermission(handle, mode)` per
   `researcher-01:64`.
3. Add `src/workspace/fs.ts` `WorkspaceFs` with `resolveSegments`, size caps, a
   private `dirFor(segments, { create })`, and a per-operation permission check
   mapping `NotAllowedError`/`SecurityError` to `WorkspacePermissionError`.
   `writeFile` uses `createWritable()` → `write` → `close`.
4. Add Dexie `version(4).stores({ vault, meta, threads, skills, tools, fs: 'id' })`
   and `FsHandleRecord`.
5. Add `src/tools/builtin/workspace.ts` implementing a `ToolProvider` whose
   `create(name, ports)` builds each tool with `jsonSchema` and calls
   `ports.workspace`. Each returns a bounded plain object.
6. Add `src/skills/workspace-source.ts` reading `<root>/.agents/skills` via
   `WorkspaceFs`, parsing each `SKILL.md`, returning manifests with
   `source: 'workspace'`.
7. Tests with `fake-handle.ts` (an in-memory tree implementing
   `getFileHandle`/`getDirectoryHandle`/`removeEntry`/`values`): path rejection for
   `/abs`, `../x`, `a\\..\\b`, `C:\\x`, `\\\\server\\share`, `nul\0`; nested
   read/write; create dir; recursive remove; size-cap errors; permission failure
   mapped to `WorkspacePermissionError`.
8. `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] `src/workspace/errors.ts`
- [x] `src/workspace/handle.ts` (pick + persist + restore + permission)
- [x] `src/workspace/fs.ts` + fake-handle tests (all rejected path classes)
- [x] Dexie version 4 `fs` table
- [x] `src/tools/builtin/workspace.ts` + tests
- [x] `src/skills/workspace-source.ts`
- [x] lint / build / full test green

## Verification

- `pnpm test -- src/workspace src/tools src/skills` passes, including every
  rejected path class.
- `pnpm build` clean.
- Journal (browser): pick a folder, list, write a file, read it back, reload,
  re-grant permission, read the file back; confirm a `../` path and a backslash
  path are rejected.
- Non-Chromium: `isPickerAvailable()` false and tools surface
  `WorkspaceUnsupportedError`.

## Success Criteria

- A granted folder is readable and writable through the system tools and survives
  reload with a permission re-grant.
- Every path-escape class is rejected with `WorkspacePathError` before touching
  the handle.
- The workspace skill source lists and parses `.agents/skills` entries as
  untrusted.
- The persisted-handle residual risk is documented in `plan.md`.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Sandbox worker reads and uses the persisted handle | Accepted user decision; documented. Key is still unreachable; main-thread tools remain validated. |
| Permission revoked mid-session | Per-operation `ensurePermission`; typed error; future UI binds re-grant to a click. |
| Symlink escapes the root | The API resolves within the handle root; policy rejects separators; document residual OS-level symlink risk. |
| Large reads exhaust memory/quota | 2 MiB caps with `WorkspaceLimitError`. |

## Security Considerations

- The persisted handle is a documented residual risk; `plan.md` records it.
- The bridge (Phase 5) passes only paths and file content, never the handle.
- File content returned to the model is untrusted input; the composer treats
  workspace skill instructions as untrusted too.

## Next Steps

Phase 5 supplies the `CodeRunner` the code tools use.
