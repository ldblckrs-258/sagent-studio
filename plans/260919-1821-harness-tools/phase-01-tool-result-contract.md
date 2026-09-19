---
phase: 1
title: "Tool Result Contract and Workspace Read Primitives"
status: pending
priority: P1
effort: "6h"
dependencies: []
---

# Phase 1: Tool Result Contract and Workspace Read Primitives

## Context Links

- Plan: [`plan.md`](./plan.md) — goals 3, 4 (stat), 9; Key Decisions "Result
  contract first" and "`read_file`/`list_dir` stay on the main thread; `search` runs
  in a worker".
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- Existing tool contracts: `src/tools/types.ts:1` (`WorkspaceEntry`,
  `WorkspaceStat`), `:19` (`WorkspaceApi`), `:58` (`ToolRuntimePorts`), `:70`
  (`ToolError` hierarchy), `:84` (`ToolRuntimeUnavailableError`).
- Existing workspace implementation: `src/workspace/fs.ts:24`
  (`DEFAULT_SIZE_CAP`), `:30` (`resolveSegments`), `:57` (`ensurePermission`),
  `:73` (`WorkspaceFs`), `:99` (`directoryFor`), `:115` (`fileFor`), `:129`
  (`list`), `:147` (`readFile`), `:192` (`stat`).
- Existing built-in providers: `src/tools/builtin/workspace.ts:5` (`NAMES`), `:23`
  (`workspaceToolProvider`); `src/tools/builtin/code.ts:39`
  (`createCodeToolProvider`); `src/tools/http.ts:113` (`executeHttpTool`).
- Registry binding: `src/tools/registry.ts:96` (`buildToolSet`), `:115`
  (`createUserTool`).
- Consumers to re-verify: `src/chat/engine.ts:102` (ports),
  `src/session/session.ts:174` (`builtinProviders`).
- Tool-result rendering seam touched by this phase: `convertToolPart`
  (`src/chat/convert.ts:42-55`), which currently hardcodes `isError: false` for an
  `output-available` part. Test: `src/chat/convert.test.ts`.
  <!-- Updated: Red Team Session 1 - isError from envelope.ok -->
- Test conventions: colocated `*.test.ts`, Vitest `environment: 'node'`
  (`vitest.config.ts`), fakes injected via `src/workspace/fake-handle.ts`
  (`createFakeWorkspace`) and `src/workspace/fs.ts` (`createWorkspaceFs`).
- Existing tests that this phase intentionally updates:
  `src/tools/builtin/workspace.test.ts:33` (five-tool name assertion), `:44`
  (raw read/write shape), `:78` (traversal now a structured failure).

## Goal

Introduce one result envelope, produced by one helper module, so every built-in
tool returns the same shape and every expected failure reaches the model with a
machine-readable `code`, a human `message`, and an actionable `hint` instead of an
opaque thrown error. On top of that contract, deliver the read primitives the rest
of the plan builds on: line-windowed `read_file`, `recursive`/glob `list_dir`, and
`stat` bound as a tool.

## Requirements

- `src/tools/result.ts` exports the envelope type, the code union, and the
  helpers `toolOk`, `toolFail`, `ToolResultError`, `toToolResult`, and
  `wrapToolExecute`. The envelope is a plain, JSON-serializable object:
  `{ ok: boolean; code: ToolResultCode; value?: T; message?: string; hint?: string; truncated?: boolean }`.
- The code union is fixed and shared:
  `'ok' | 'invalid_input' | 'path_rejected' | 'permission_denied' | 'not_found' | 'limit_exceeded' | 'no_match' | 'multiple_matches' | 'conflict' | 'approval_required' | 'denied' | 'timeout' | 'disabled' | 'http_error' | 'runtime_error'`.
- Expected failures RETURN a failure envelope. The only error that may reject the
  tool promise is `ToolRuntimeUnavailableError` (`src/tools/types.ts:84`), a
  genuine runtime-unavailable condition. Every other error is caught and becomes a
  structured envelope: recognized errors map to their code (`WorkspacePathError` →
  `path_rejected`, `WorkspacePermissionError` → `permission_denied`,
  `WorkspaceNotFoundError` → `not_found`, `WorkspaceLimitError` → `limit_exceeded`,
  `HttpToolError` → `http_error`, `ToolSchemaError` → `invalid_input`), and any
  error NOT in that table — including an unrecognized `DOMException` rethrown by
  `mapDomError` (`src/workspace/fs.ts:43-51`) and any arbitrary programming error —
  becomes a structured `runtime_error` envelope rather than a rejection.
  <!-- Updated: Red Team Session 1 - runtime_error catch-all, only runtime-unavailable may reject -->
- `read_file` accepts optional `offset` (1-based line) and `limit` (line count)
  and returns `{ path, content, totalLines, returnedLines, offset, truncated }`.
  Content outside the window is not returned. `truncated` is true when the window
  ends before `totalLines`. Omitting both returns the whole file with
  `truncated: false`.
- `list_dir` accepts optional `recursive` (boolean), `glob` (string), and
  `maxEntries` (positive integer) and returns `{ path, entries, truncated }` where
  each entry is `{ name, path, kind, size? }`. `truncated` is true when
  `maxEntries` stopped the walk.
- `stat` is bound as a tool returning `{ path, kind, size }` from the existing
  `WorkspaceFs.stat` (`src/workspace/fs.ts:192`).
- `WorkspaceApi.list` gains an optional second parameter; `WorkspaceFs.list` gains
  the same. Existing one-argument callers keep compiling and keep the previous
  behavior.
- The 2 MiB `DEFAULT_SIZE_CAP` (`src/workspace/fs.ts:24`) is unchanged and still
  enforced on read and write.
- All new workspace operations route through `resolveSegments` (`:30`) and
  `ensurePermission` (`:57`). No new path or permission path is introduced.
- `src/workspace/glob.ts` and `src/workspace/lines.ts` are pure, dependency-free
  helpers so both the fs layer and the tool layer share one implementation.

## Architecture

**Data flow — a tool call.**

1. The model emits a tool call; the AI SDK invokes the tool's `execute` with the
   parsed input (`src/tools/registry.ts:96` built the tool set).
2. `wrapToolExecute` runs the tool body. A recognized failure is caught and
   converted to a failure envelope; a `ToolRuntimeUnavailableError` is rethrown; any
   other error, recognized or not, becomes a `runtime_error` failure envelope.
   <!-- Updated: Red Team Session 1 - runtime_error catch-all -->
3. The envelope is returned as the tool output. The AI SDK serializes it as a
   normal (non-error) tool result, so the model sees `code`/`message`/`hint` on the
   next step. Rationale: a thrown error becomes a `tool-error` part and loses the
   hint (`research/researcher-01-ai-sdk-approval.md`, §2).
4. The UI renders the envelope through the existing tool-part path, except that
   `convertToolPart` (`src/chat/convert.ts:42-55`) must derive `isError` from
   `envelope.ok === false` for an `output-available` result, so a failure envelope
   is not shown as a successful tool call.
   <!-- Updated: Red Team Session 1 - isError from envelope.ok -->

**Data flow — `list_dir` recursive.** The tool calls `WorkspaceApi.list(path,
{ recursive, glob, maxEntries })`. `FileWorkspaceFs.list` resolves the start
directory through `directoryFor` (`src/workspace/fs.ts:99`), then walks with
`for await (const child of directory.values())` (already declared for the type at
`src/workspace/fs.ts:15`). Each child is pushed as an entry; a directory child is
recursed into when `recursive` is set. The walk stops as soon as the entry count
reaches `maxEntries` and reports `truncated: true`. Globs are matched against the
entry's root-relative `path` using `src/workspace/glob.ts`.

**Data flow — `read_file` window.** The tool calls `WorkspaceApi.readFile(path)`,
which enforces the size cap, then applies `sliceLines` from
`src/workspace/lines.ts` on the main thread. Reading the whole capped file and
slicing is correct and simple because the cap already bounds the input at 2 MiB;
no streaming read is added.

**Envelope shape.** Success carries `value` and `code: 'ok'`. Failure carries
`code`, `message`, and (where a retry exists) `hint`, and may still carry `value`
with partial data (for example a sandbox `RunResult` alongside its error). `ok` is
exactly `code === 'ok'`, so a caller can branch on either.

## Files to Create / Modify

Create:

- `src/tools/result.ts` — envelope, code union, helpers.
- `src/tools/result.test.ts`
- `src/workspace/lines.ts` — `sliceLines`, `countLines`.
- `src/workspace/lines.test.ts`
- `src/workspace/glob.ts` — `compileGlob`, `matchesGlob`.
- `src/workspace/glob.test.ts`

Modify:

- `src/tools/types.ts` — add `WorkspaceListOptions`, extend `WorkspaceApi.list`.
- `src/workspace/fs.ts` — implement the recursive/glob `list`, keep `stat` as is.
- `src/tools/builtin/workspace.ts` — add `stat` to `NAMES`; envelope every tool;
  `read_file` offset/limit; `list_dir` options.
- `src/tools/builtin/code.ts` — envelope the runner result.
- `src/tools/http.ts` — return an envelope instead of throwing `HttpToolError`.
- `src/tools/registry.ts` — envelope the `sandbox-js` user-tool result
  (`createUserTool`, `:115`).
- `src/chat/convert.ts` — derive `isError` from `envelope.ok === false` for an
  `output-available` result, so a failure envelope is not rendered as success.
  This phase's only `src/chat` edit; Phase 4 later touches the same file for the
  approval branch, strictly after this one.
  <!-- Updated: Red Team Session 1 - isError from envelope.ok -->
- `src/tools/builtin/workspace.test.ts`, `src/tools/builtin/code.test.ts`,
  `src/tools/http.test.ts`, `src/tools/registry.test.ts`,
  `src/workspace/fs.test.ts` — update assertions to the envelope.
- `src/chat/convert.test.ts` — add the `output-available` failure-envelope case.
  <!-- Updated: Red Team Session 1 - isError from envelope.ok -->

Do not modify: `src/chat/**` except `src/chat/convert.ts` and
`src/chat/convert.test.ts`, `src/sandbox/**`, `src/skills/**`, `src/vault/**`,
`src/ui/**`.

## Test Plan

Unit — `src/tools/result.test.ts`

- `toolOk` produces `{ ok: true, code: 'ok', value }` with no `message`.
- `toolFail` produces `ok: false` with the given code, message, and hint.
- `toToolResult` maps each recognized error `name` to its code and preserves a
  hint when one is supplied by context. Cases: `WorkspacePathError`,
  `WorkspacePermissionError`, `WorkspaceNotFoundError`, `WorkspaceLimitError`,
  `HttpToolError`, `ToolSchemaError`.
- `toToolResult` rethrows `ToolRuntimeUnavailableError` and converts an arbitrary
  `new Error('boom')` to a `runtime_error` envelope.
- An error whose `name` is not in the table becomes a `runtime_error` envelope, so
  an unexpected failure reaches the model as a structured result instead of a
  rejected promise. A `DOMException` that `mapDomError` (`src/workspace/fs.ts:43-51`)
  would rethrow is covered by the same case.
- `wrapToolExecute` returns a failure envelope for a recognized error and for an
  unrecognized error, and rethrows only a runtime-unavailable error.
  <!-- Updated: Red Team Session 1 - runtime_error catch-all -->

Unit — `src/chat/convert.test.ts`

- An `output-available` tool part whose output is an envelope with `ok: false`
  converts to a `tool-call` part with `isError: true`.
- An `output-available` tool part whose output is an envelope with `ok: true`
  converts with `isError: false`.
- A non-envelope `output-available` output still converts as before, so existing
  tool results are unaffected.
  <!-- Updated: Red Team Session 1 - isError from envelope.ok -->

Unit — `src/workspace/lines.test.ts`

- `sliceLines(text, {})` returns every line and `truncated: false`.
- A 1-based `offset` with `limit` returns exactly that window and
  `totalLines > returnedLines`.
- An `offset` past the end returns zero lines and `truncated: false`.
- CRLF input splits without a trailing `\r`.
- A trailing newline does not invent an extra empty line.

Unit — `src/workspace/glob.test.ts`

- `**/*.ts` matches a nested path and a root path.
- `src/*` matches one level only.
- `?` matches exactly one character; a literal `.` is not a wildcard.
- Invalid input does not throw; it returns `false`.

Unit — `src/workspace/fs.test.ts`

- A recursive `list` returns nested entries with root-relative `path` values,
  directories before files is not required by this phase (order is
  implementation-defined), but every nested path must appear.
- A glob-filtered `list` returns only matching paths.
- `maxEntries` truncates the walk.
- A `..` path still throws `WorkspacePathError` with the new options supplied.
- A permission-denied handle still throws `WorkspacePermissionError`.
- The size cap still rejects a file above `DEFAULT_SIZE_CAP` on `readFile` and
  `writeFile`.

Unit — `src/tools/builtin/workspace.test.ts`

- The tool set built from `workspaceToolProvider` contains exactly these names, in
  the sorted order `buildToolSet` already produces (`list_dir`, `make_dir`,
  `read_file`, `remove`, `stat`, `write_file`).
- `read_file` with no options returns the whole file and `truncated: false`.
- `read_file` with `offset: 2, limit: 1` returns the second line only and
  `totalLines` for the file.
- `list_dir` with `recursive: true` returns nested entries; with `glob` returns
  only matches; the result carries `truncated`.
- `stat` returns `{ path, kind, size }`.
- A traversal path returns `{ ok: false, code: 'path_rejected' }` and does NOT
  reject the promise.
- Removing the workspace port makes the provider unavailable
  (`ToolRuntimeUnavailableError` still thrown from `create`).

Unit — `src/tools/builtin/code.test.ts` and `src/tools/http.test.ts`

- A successful runner result is a success envelope whose `value` is the
  `RunResult`.
- A runner timeout failure (the runner rejects with `SandboxTimeoutError`) is a
  `timeout` failure envelope when the runner rejects, and a `runtime_error`
  failure envelope when the manager returned a `RunResult` with `error`.
- An http 500 is an `http_error` failure envelope, not a rejection.

Integration — `src/tools/registry.test.ts`

- `buildToolSet` still returns every available built-in and every enabled user
  tool; a `sandbox-js` user tool now resolves to an envelope.

Regression

- `src/chat/engine.test.ts` passes unchanged; no engine contract moves in this
  phase.

## Implementation Steps

1. Write `src/tools/result.ts`. Start from the code union and the `ToolResult<T>`
   interface. Implement `toolOk`, `toolFail`, and `ToolResultError` (carrying
   `code`, `message`, `hint`) first, then `toToolResult(error, context?)` with one
   lookup-table entry per recognized `error.name`, then `wrapToolExecute`. Any error
   whose name is not in the table returns a `runtime_error` envelope; only
   `ToolRuntimeUnavailableError` is rethrown. Import only
   `ToolRuntimeUnavailableError` from `./types` as a runtime value; map the
   workspace and http errors by name so `result.ts` never imports `http.ts` (which
   imports this module). Verify with `pnpm build`.
   <!-- Updated: Red Team Session 1 - runtime_error catch-all -->
2. Write `src/tools/result.test.ts` and run `pnpm test src/tools/result.test.ts`.
3. Write `src/workspace/lines.ts` (`splitLines`, `countLines`, `sliceLines`) and
   `src/workspace/glob.ts` (`compileGlob`, `matchesGlob`). Both are pure and
   dependency-free. Write their tests and run them.
4. Extend `src/tools/types.ts`: add the `WorkspaceListOptions` interface and the
   optional second parameter on `WorkspaceApi.list`. Keep the interface
   structurally backward compatible so the three inline fakes listed in
   `plan.md` still satisfy it.
5. Extend `FileWorkspaceFs.list` in `src/workspace/fs.ts` to honor
   `recursive`, `glob`, and `maxEntries`, reusing `resolveSegments`,
   `directoryFor`, and `mapDomError`. Add a private `walk` generator so the
   recursion is one function, not a duplicated loop.
6. Update `src/tools/builtin/workspace.ts`: import the envelope helpers; add
   `'stat'` to `NAMES`; add `offset`/`limit`/`recursive`/`glob`/`maxEntries` to the
   relevant JSON schemas; wrap each `execute` with `wrapToolExecute`; return
   `toolOk(...)` values.
7. Update `src/tools/builtin/code.ts`, `src/tools/http.ts`, and
   `src/tools/registry.ts` (`createUserTool`) to produce envelopes. For
   `executeHttpTool`, return an envelope instead of throwing `HttpToolError`;
   keep `HttpToolError` as the internal signal so `toToolResult` can map it.
8. Update the affected tests to assert envelope shapes rather than raw values.
   Keep every existing security assertion (traversal, permission, size cap) and
   change only its expected representation.
9. In `src/chat/convert.ts`, derive `isError` in `convertToolPart`
   (`:42-55`) from `envelope.ok === false` for an `output-available` result, and add
   the case to `src/chat/convert.test.ts`. This is the phase's only `src/chat` edit.
   <!-- Updated: Red Team Session 1 - isError from envelope.ok -->
10. Run `pnpm test`, then `pnpm lint` and `pnpm build` (this phase touches a public
    model-facing contract).

## Todo

- [ ] `src/tools/result.ts` with envelope, code union, and five helpers
- [ ] `src/tools/result.test.ts` green, including the rethrow cases
- [ ] `src/workspace/lines.ts` + test
- [ ] `src/workspace/glob.ts` + test
- [ ] `WorkspaceListOptions` added to `src/tools/types.ts` additively
- [ ] `FileWorkspaceFs.list` honors `recursive`, `glob`, `maxEntries`
- [ ] `stat` bound as a tool in `workspaceToolProvider`
- [ ] `read_file` line window with `totalLines` and `truncated`
- [ ] `code.ts`, `http.ts`, `registry.ts` return envelopes
- [ ] Existing workspace/code/http/registry/fs tests updated to the envelope
- [ ] Unknown errors (including an unmapped `DOMException`) return `runtime_error`,
      and only `ToolRuntimeUnavailableError` rejects
      <!-- Updated: Red Team Session 1 - runtime_error catch-all -->
- [ ] `convertToolPart` derives `isError` from `envelope.ok === false`, with a
      `convert.test.ts` case
      <!-- Updated: Red Team Session 1 - isError from envelope.ok -->
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [ ] Every built-in tool (`list_dir`, `read_file`, `write_file`, `make_dir`,
      `remove`, `stat`, `run_js`, `run_python`) and every user tool returns the
      envelope shape, proven by tests that assert `ok`, `code`, and the presence
      of `value` or `message`.
- [ ] A traversal path returns `code: 'path_rejected'` as a value; a
      permission-denied handle returns `code: 'permission_denied'`; a file above
      the cap returns `code: 'limit_exceeded'`. No promise rejects for any of
      these.
- [ ] `ToolRuntimeUnavailableError` still throws when the workspace or runner port
      is absent, proven by a test.
- [ ] An unrecognized error, including an unmapped `DOMException`, returns a
      `runtime_error` envelope; no built-in tool promise rejects for it.
      <!-- Updated: Red Team Session 1 - runtime_error catch-all -->
- [ ] A failure envelope with `ok: false` renders as an error tool part; a success
      envelope renders as a non-error part.
      <!-- Updated: Red Team Session 1 - isError from envelope.ok -->
- [ ] `read_file` returns exactly the requested line window with `totalLines` and
      a correct `truncated`.
- [ ] `list_dir` returns nested entries with `recursive: true`, filters with
      `glob`, and reports `truncated` when `maxEntries` stops the walk.
- [ ] `stat` returns the same `{ path, kind, size }` object as
      `WorkspaceFs.stat`.
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.
- [ ] No file under `src/sandbox`, `src/skills`, `src/vault`, or `src/ui` changed,
      and the only `src/chat` files changed are `src/chat/convert.ts` and
      `src/chat/convert.test.ts`.
      <!-- Updated: Red Team Session 1 - scoped src/chat exception -->

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Envelope adoption breaks the model-facing shape of every existing tool | High × Low | Intentional and in scope for goal 9. Every affected test is updated in the same step, and the phase explicitly lists them. |
| A runtime import cycle is introduced because `http.ts` imports the envelope helper while `result.ts` would need `HttpToolError` | Medium × Medium | `toToolResult` maps by `error.name` through a lookup table, not `instanceof`, for the workspace and http error classes. Every class in `src/workspace/errors.ts` and `HttpToolError` (`src/tools/types.ts:105`) sets `this.name` in its constructor, so the table is stable and needs no import from `http.ts`. The single exception is `ToolRuntimeUnavailableError`, which `result.ts` imports from `./types`; `types.ts` does not import `result.ts`, so that edge is acyclic. Verify with `pnpm build` and an ESLint pass for import cycles. |
| A recursive walk on a huge tree stalls or exhausts memory | Medium × Medium | `maxEntries` with a default cap stops the walk deterministically; `values()` is async and yields between directory reads. |
| Glob semantics diverge from a user's shell expectation | Medium × Low | A small documented matcher (`*`, `**`, `?`) with its own test file; `**` is the only cross-directory operator. |
| Changing `WorkspaceApi.list` breaks one of the three inline fakes | Medium × Low | The parameter is optional and the interface stays structurally satisfiable; `pnpm test` covers all three fake sites. |
| Line slicing disagrees with an editor on CRLF or a trailing newline | Low × Low | Explicit tests for CRLF and a trailing newline; the helper is the single implementation. |

**Rollback.** Revert this phase's files and test updates. No later phase depends on
anything outside `src/tools/result.ts`, `src/workspace/lines.ts`,
`src/workspace/glob.ts`, and the extended `list` signature; reverting removes those
and restores the raw shapes. No persisted data changes, so no data rollback is
needed.

## Security Considerations

- Path validation is untouched: every new operation calls `resolveSegments`
  (`src/workspace/fs.ts:30`) and `ensurePermission` (`:57`). The recursive walk
  resolves each child from the already-validated parent handle, so it cannot
  escape the granted root.
- The size cap is not relaxed. `read_file`'s window is computed from an
  already-capped read, so it cannot be used to read beyond 2 MiB.
- A failure envelope carries only the error message already produced by the
  workspace layer; no absolute host path is included, and no secret is added.
  `redactSecrets` (`src/chat/engine.ts:66-70`) applies only to the run-level error
  string set at `src/chat/engine.ts:272` (`useChatStore.setError`); tool results are
  NOT redacted. Surfacing a workspace secret through a tool result is therefore an
  accepted, documented risk, not a mitigated one, and this plan does not claim
  otherwise. `convertToolPart`'s `isError` derivation does not change that.
  <!-- Updated: Red Team Session 1 - redactSecrets scope corrected -->
- The `runtime_error` catch-all envelope carries the error's own message and
  nothing more; it never includes the tool input or a stack trace.
- `glob` is compiled to a `RegExp` with escaped literals; an invalid pattern is
  treated as no match, never evaluated as code.
- No new message kind crosses a worker boundary, so the `CryptoKey` boundary is
  unchanged.

## Next Steps

Phase 2 imports `src/tools/result.ts` for `edit_file`, `search`, `move`, and
`copy`, and extends `WorkspaceApi` with the move/copy operations on the same
additive pattern established here.
