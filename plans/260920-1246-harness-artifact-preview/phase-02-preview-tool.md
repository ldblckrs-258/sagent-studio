---
phase: 2
title: "Preview Tool and Authored-Sandbox Target"
status: implemented
priority: P1
effort: "8h"
dependencies: [1]
---

# Phase 2: Preview Tool and Authored-Sandbox Target

## Context Links

- `src/session/file-view-state.ts` — the `FileTarget` model and zustand store (seam).
- `src/ui/shell.tsx:266-282` — store subscription that reveals the File panel.
- `src/ui/panels/file-editor.tsx:120-132` — viewer dispatcher; needs a remount key.
- `src/ui/panels/workspace.tsx:63-66` — user file tap calls `onOpenFile(node.path)`.
- `src/tools/types.ts:174` — `ToolRuntimePorts`.
- `src/session/session.ts:181-190,248-269` — provider registration, introspection ports, and the hardcoded introspection array.
- `src/chat/engine.ts:42-59,217-228` — pipeline ports.
- `src/chat/approval.ts:18` — gated-only policy lookup (why a non-gated `deny` cannot apply).
- `src/tools/approval.ts:14-57,88-104` — gated/read-only sets and the exact-set test.
- Phase 1 — the artifact HTML runtime the authored branch delegates to.

## Goal

Let the model open a workspace file in the File panel through a new `open_preview` tool, with model-presented content sandboxed more strictly than user-opened content and a user's active edit preserved.

## Requirements

- Functional: an `open_preview` tool; the target reveals the File panel.
- Functional: a model open reloads the viewer even for the already-open path; a user re-click of the active path does not remount.
- Functional: a missing or directory path fails without changing the target.
- Security: a path the model presented stays in an `authored` set for the session; its HTML uses a sandbox without `allow-same-origin`, including after a later user reopen. A never-presented user-open keeps `PREVIEW_SANDBOX`.
- Non-functional: no tool imports a UI store; all wiring passes through `ToolRuntimePorts`.
- Non-functional: `open_preview` is permitted in `read_only`; the non-gated limitation is documented.

## Architecture

```
model turn
  └─ write_file(path, content)            (existing, gated)
  └─ open_preview(path)                   (new, navigational, non-gated)
        └─ ports.preview.open(path)        PreviewPort
              └─ useFileViewStore.presentWorkspace(path)
                    ├─ authored.add(path)            (sticky for the session)
                    ├─ target = { kind:'workspace', path }
                    └─ revision += 1
                          └─ shell subscription → rail open, panel 'files'
                                └─ FilePanel key = path#revision → viewer reloads
                                      └─ HtmlView.authored.has(path)
                                            ? ArtifactHtmlRuntime (Phase 1, opaque origin)
                                            : srcDoc + PREVIEW_SANDBOX (existing)
```

`FileTarget` is unchanged. `PreviewPort` is the only new boundary. `session.ts` builds it from the store because it is already the composition root; `engine.ts` forwards it into `ToolRuntimePorts` next to `workspace` and `sandbox`.

## Related Code Files

Create:

- `src/tools/builtin/preview.ts` — the provider.
- `src/tools/builtin/preview.test.ts` — tool behavior.

Modify:

- `src/session/file-view-state.ts` — `revision` + `authored` + `presentWorkspace`; no `FileTarget` shape change.
- `src/session/file-view-state.test.ts` — new store semantics.
- `src/tools/types.ts` — `PreviewPort`; `ports.preview`.
- `src/chat/engine.ts` — `PipelineDeps.preview`; pass into `buildRunStream` ports.
- `src/session/session.ts` — build the port, register the provider, add it to the introspection array and ports.
- `src/session/session.test.ts` — assert the tool appears in `builtinProviders()`.
- `src/tools/approval.ts` — add `open_preview` to `READ_ONLY_TOOLS`.
- `src/tools/approval.test.ts` — exact read-only set expectation + classification cases.
- `src/ui/file-view/html-view.tsx` — branch authored targets to the Phase 1 runtime.
- `src/ui/panels/file-editor.tsx` — remount key on the viewer container.

## Implementation Steps

1. In `src/session/file-view-state.ts`, leave `FileTarget` untouched. Add to the state:

   ```ts
   export interface FileViewState {
     target: FileTarget | null
     revision: number
     /** Paths the model has presented this session; drives the strict HTML sandbox. */
     authored: ReadonlySet<string>
     /** User-initiated open. A no-op when the same workspace path is already active. */
     openWorkspace(path: string): void
     openUrl(url: string): void
     /** Model-initiated open. Marks authorship and always reloads, even for the active path. */
     presentWorkspace(path: string): void
     clear(): void
   }
   ```

   Implement `openWorkspace`: if `target` is a workspace target with the same `path`, return unchanged; otherwise set `{ target: { kind: 'workspace', path }, revision: revision + 1 }`. Implement `presentWorkspace`: add `path` to a new `authored` set and always set the target with `revision + 1`. Keep `openUrl` and `clear` (adding the new fields to their `set` calls). Export `targetKey(target: FileTarget | null, revision: number): string` returning `` `workspace:${target.path}:${revision}` ``, `` `url:${target.url}` ``, or `'none'`.

2. In `src/tools/types.ts`, add:

   ```ts
   export interface PreviewPort {
     open(path: string): void
   }
   ```

   and `preview?: PreviewPort` on `ToolRuntimePorts`.

3. Create `src/tools/builtin/preview.ts` with `createPreviewToolProvider()`, `names: ['open_preview']`, `isAvailable: (ports) => ports.workspace !== undefined && ports.preview !== undefined`. `open_preview` input `{ path: string }`: read `ports.workspace`; if absent throw `ToolRuntimeUnavailableError`. `const info = await workspace.stat(path)`; if `info.kind === 'directory'` return `toolFail('invalid_input', ...)` with a hint. Read `ports.preview`; if absent throw `ToolRuntimeUnavailableError`. Call `preview.open(info.path)`; return `toolOk({ path: info.path, opened: true })`. Use `wrapToolExecute`, `jsonSchema`, and the `tool` helper, matching `src/tools/builtin/sandbox-control.ts`. Do not add a `close_preview` tool.

4. In `src/ui/file-view/html-view.tsx`, read authorship for the active workspace path and branch:

   ```tsx
   const authored = useFileViewStore((s) =>
     s.target?.kind === 'workspace' ? s.authored.has(s.target.path) : false,
   )
   ```

   When `authored` is true, render the Phase 1 `ArtifactHtmlRuntime` with the loaded draft. When false, keep the existing `srcDoc` iframe with `PREVIEW_SANDBOX`. The remote branch is unchanged.

5. In `src/ui/panels/file-editor.tsx`, read `revision` from the store and key the viewer container with `targetKey(target, revision)`, so a model reload remounts the viewer while a user re-click does not.

6. In `src/chat/engine.ts`, add `preview?: PreviewPort` to `PipelineDeps` and include `preview: deps.preview` in the `ports` object inside `buildRunStream` (`src/chat/engine.ts:217`).

7. In `src/session/session.ts`, build the port near `getWorkspace`:

   ```ts
   const previewPort = (): PreviewPort => ({
     open: (path) => useFileViewStore.getState().presentWorkspace(path),
   })
   ```

   Create `const previewProvider = createPreviewToolProvider()`. Register it alongside the other providers (`session.ts:181`), add `preview: previewPort()` to the `deps` object (`session.ts:192`), add it to the ports object in `builtinProviders` (`session.ts:250`), and add `previewProvider` to the hardcoded introspection array (`session.ts:260-269`).

8. In `src/tools/approval.ts`, add `'open_preview'` to `READ_ONLY_TOOLS`.

9. Update and add tests:
   - `src/tools/builtin/preview.test.ts` (mirror `sandbox-control.test.ts`): opens and records the path; directory path → `invalid_input`; missing path → `not_found`; provider unavailable without a workspace or without a preview port.
   - `src/session/file-view-state.test.ts`: `openWorkspace` twice with the same path leaves `revision` unchanged; `openWorkspace` for a different path increments; `presentWorkspace` increments and adds to `authored`; `targetKey` differs across revisions and matches for a no-op.
   - `src/session/session.test.ts`: assert `session.builtinProviders()` includes `open_preview`.
   - `src/tools/approval.test.ts`: add `open_preview` to the exact sorted read-only set at `approval.test.ts:91-104`; assert `resolveApprovalStatus('read_only', { tools: {} }, 'open_preview') === 'approved'`.

10. Document in the plan/PR notes that `open_preview` is non-gated, so a persisted `deny` does not apply (`src/chat/approval.ts:18` consults policy only for gated tools). Do not add it to `GATED_BUILTINS`, which would force an approval prompt on every open.

## Verification

```bash
pnpm vitest run src/tools/builtin/preview.test.ts src/session/file-view-state.test.ts src/session/session.test.ts src/tools/approval.test.ts
pnpm lint
pnpm build
```

## Todo

- [ ] Add `revision`/`authored`/`presentWorkspace`/`targetKey` to the file-view store (no `FileTarget` change).
- [ ] Add `PreviewPort` to `ToolRuntimePorts`.
- [ ] Create the `open_preview` provider.
- [ ] Branch authored targets to the Phase 1 opaque-origin runtime in `html-view.tsx`.
- [ ] Key the File panel viewer container by `targetKey`.
- [ ] Plumb `preview` through `engine.ts` and `session.ts` (deps, introspection ports, and the introspection array).
- [ ] Classify `open_preview` as read-only in `approval.ts`.
- [ ] Update `approval.test.ts` exact-set expectation.
- [ ] Add/update the four test files and make them pass.

## Success Criteria

- `open_preview` opens the File panel with the correct target and a bumped revision; a model re-open of the active path still reloads.
- A user re-click of the active path is a no-op and preserves unsaved edits.
- A model-presented HTML path renders through the Phase 1 opaque-origin runtime, including after a later user reopen; a never-presented user file keeps the existing `srcDoc` preview.
- A missing path fails with a tool envelope and does not change the target.
- `open_preview` is approved in `read_only`, `editing`, and `god`.
- The focused vitest files, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `builtinProviders` introspection diverges from runtime ports and mislabels availability | Add `preview` to the ports object and `previewProvider` to the introspection array; cover with a `session.test.ts` assertion |
| A model reload of a path the user is editing discards the draft | Only model opens force a reload; user re-clicks are no-ops. The save bar's unsaved indicator remains visible; this residual is documented in the plan risk table |
| Moving `authored` into zustand makes the set identity churn and re-render `HtmlView` | Replace the set immutably only in `presentWorkspace`; `HtmlView` selects a boolean |
| A persisted `deny` on `open_preview` is silently ignored | Documented non-gated limitation; the tool only performs a read-only `stat` and a UI navigation |

## Security Considerations

- A model-presented HTML file renders through the Phase 1 opaque-origin runtime, so it cannot read app-origin storage (including the unlocked vault) or the parent DOM. Authorship is sticky for the session, so a later user reopen cannot upgrade it.
- Tools receive only a path; the workspace API still enforces folder containment, and `open_preview` only performs a read-only `stat`.
- No `close_preview`, so the model cannot clear a file the user opened.

## Next Steps

Phase 3 adds the Markdown and JSON viewers that the `file-editor.tsx` dispatcher routes to.
