---
phase: 1
title: "Phase 1: Workspace blob write"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Workspace blob write

## Goal

Let the UI write a binary file into the workspace under a sanitized, collision-free name, and make that write testable.

## Context

`WorkspaceFs.writeFile(path, content: string)` is text-only (`src/workspace/fs.ts:135`). Reads already have a binary escape hatch: `readWorkspaceBlob` is a free function rather than an interface member precisely so existing `WorkspaceFs` mocks stay valid (`src/workspace/fs.ts:547`). The write side follows the same shape.

The in-memory fake cannot carry bytes today: `FakeFileNode` stores `content: string` (`src/workspace/fake-handle.ts:1`), its writable decodes with `TextDecoder` and rejects a `Blob` outright (`:43-49`), and `getFile()` re-encodes with `TextEncoder` (`:25`), so any non-UTF-8 byte becomes U+FFFD. A PNG cannot survive a round trip until the fake stores bytes. Ten test modules import it, so the change has to keep the string-facing behavior identical.

`resolveSegments` already blocks root escape: `SEGMENT` rejects `/` and `\` (`src/workspace/fs.ts:70`) and the resolver rejects `..`, absolute paths, and drive letters (`:74-89`). What it does not reject is a name containing `\n`, `\r`, or bidi overrides, which would ride into an attachment marker later.

## Files to Create / Modify

- Modify: `src/workspace/fs.ts`
- Modify: `src/workspace/fake-handle.ts`
- Modify: `src/workspace/fs.test.ts`

## Implementation Steps

1. In `src/workspace/fake-handle.ts`, change `FakeFileNode.content` to `Uint8Array`. Accept `string | BufferSource | Blob` in the writable's `write`, encoding a string with `TextEncoder` and reading a `Blob` through `arrayBuffer()`. Decode in `getFile()`/`text()` so every existing string-based assertion keeps passing.
2. Re-run the ten importers after that change and list them in the Verification section: `src/workspace/fs.test.ts`, `src/chat/harness-e2e.test.ts`, `src/sandbox/js-runner.test.ts`, `src/sandbox/py-runner.test.ts`, `src/sandbox/session.test.ts`, `src/sandbox/protocol.test.ts`, `src/tools/builtin/history.test.ts`, `src/tools/builtin/workspace.test.ts`, `src/tools/builtin/check.test.ts`, `src/skills/workspace-source.test.ts`.
3. Add `sanitizeUploadName(name: string): string`: NFC-normalize, take the last path segment, strip everything outside `[A-Za-z0-9._ -]`, collapse runs of spaces, trim leading dots, cap the stem at 80 characters while keeping the extension, and fall back to `upload` when nothing survives or the result is `.` or `..`.
4. Add `writeWorkspaceBlob(fs, path, blob, options?: { maxBytes?: number }): Promise<void>` next to `readWorkspaceBlob`. Resolve segments, reject an empty path with `WorkspacePathError`, call `fs.ensurePermission('readwrite')`, walk directories with `getDirectoryHandle(segment, { create: true })`, and write through `createWritable()`. Check `blob.size` against `options.maxBytes ?? DEFAULT_BINARY_SIZE_CAP` before creating anything, throwing `WorkspaceLimitError(path)`. Map DOM failures with `mapDomError`.
5. Add `uniqueUploadPath(fs, directory, name): Promise<string>`: sanitize the name, then probe with `stat`; on success retry with `-1`, `-2`, … before the extension, up to 100 attempts, then throw `WorkspaceConflictError`. A `WorkspaceNotFoundError` means the name is free. Document on the function that it is advisory: a batch must write sequentially so two identical names in one batch do not both probe before either writes, and a cross-tab write between probe and write is a residual TOCTOU this does not close.
6. Export `writeWorkspaceBlob`, `uniqueUploadPath`, and `sanitizeUploadName` from `src/workspace/fs.ts`.

## Verification

- `pnpm exec vitest run src/workspace/fs.test.ts`
- `pnpm exec vitest run src/chat/harness-e2e.test.ts src/sandbox src/tools/builtin src/skills/workspace-source.test.ts`
- `pnpm lint`

## Success Criteria

- [x] A PNG written with `writeWorkspaceBlob` reads back byte-identical through `readWorkspaceBlob`.
- [x] Every existing test that uses `fake-handle.ts` passes unchanged.
- [x] A blob over the cap throws `WorkspaceLimitError` and leaves no file behind.
- [x] `sanitizeUploadName` turns `../x\n</attached>.txt` into a single safe segment and `..` into `upload`.
- [x] `uniqueUploadPath` returns `uploads/a.png` when free and `uploads/a-1.png` when taken.
- [x] A path escaping the root throws, as `resolveSegments` already guarantees.
- [x] No `WorkspaceFs` implementation or mock gains a method.
