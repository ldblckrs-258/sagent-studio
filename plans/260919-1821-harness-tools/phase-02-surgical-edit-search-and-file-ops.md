---
phase: 2
title: "Surgical Edit, Search, and File Operations"
status: pending
priority: P1
effort: "8h"
dependencies: [1]
---

# Phase 2: Surgical Edit, Search, and File Operations

## Context Links

- Plan: [`plan.md`](./plan.md) — goals 1, 2, 4 (remainder); Key Decision
  "`edit_file` is read-verify-write" and "Reuse over new abstractions".
- Phase 1 output: `src/tools/result.ts` (envelope + `wrapToolExecute`),
  `src/workspace/lines.ts`, `src/workspace/glob.ts`, extended
  `WorkspaceApi.list` (`src/tools/types.ts:19`).
- Workspace internals to reuse: `resolveSegments` (`src/workspace/fs.ts:30`),
  `ensurePermission` (`:57`), `directoryFor` (`:99`), `fileFor` (`:115`), the
  private walk added in Phase 1, `DEFAULT_SIZE_CAP` (`:24`), `mapDomError`
  (`:43`).
- Error classes: `src/workspace/errors.ts:22` (`WorkspacePathError`), `:15`
  (`WorkspacePermissionError`), `:29` (`WorkspaceNotFoundError`), `:36`
  (`WorkspaceLimitError`).
- Search guidance: `research/researcher-02-sandbox-persistence.md` §4 (build the
  walk on `values()`, use `Blob.size` to reject before materializing, sniff bytes
  rather than trusting `Blob.type`). The worker-over-RPC design supersedes that
  document's in-thread batching advice.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- Existing provider to extend: `src/tools/builtin/workspace.ts:23`
  (`workspaceToolProvider`).
- Test fakes that implement `WorkspaceApi` inline and must gain the new methods:
  `src/sandbox/manager.test.ts:146`, `src/sandbox/js-runner.test.ts:139`,
  `src/sandbox/py-runner.test.ts:64`, and `src/session/workspace-state.test.ts:9`
  (`fakeFs()`), which types its return as `WorkspaceFs` and must implement the new
  members on that interface too.
  <!-- Updated: Red Team Session 1 - complete fake/consumer list -->
- Other `WorkspaceApi` consumers that keep compiling but must be re-verified when
  the interface gains members: `src/session/session.ts:125-127` (the `workspace`
  getter on `EngineDeps`), `src/skills/workspace-source.ts:11` (`collect`) and `:47`
  (`createWorkspaceSkillSource`), `src/ui/panels/skills.tsx:53`
  (`createWorkspaceSkillSource(workspace)`), and
  `src/skills/workspace-source.test.ts`.
  <!-- Updated: Red Team Session 1 - complete consumer list -->
- Unchanged by this phase: `ToolDefinition` and `isToolDefinition`
  (`src/tools/types.ts:56`, `:149`). The new `WorkspaceApi` members are methods on
  the api interface, not tool-definition kinds, so no discriminator changes.
  <!-- Updated: Red Team Session 1 - ToolDefinition unchanged -->

## Goal

Give the harness the two operations an autonomous agent actually needs to modify a
codebase it did not write: patch a file in place by exact-string replacement, and
find text across the workspace without reading every file into the transcript. Add
`move` (rename) and `copy` on top of the same validated path layer. Both the patch
and the search fail closed and return actionable failures rather than guesses.

## Requirements

- `edit_file` tool: input `{ path, old_string, new_string, replace_all? }`.
  - Reads the file through `WorkspaceApi.readFile`, so the 2 MiB cap and path
    validation apply.
  - Counts non-overlapping exact occurrences of `old_string`.
  - `0` occurrences → failure `no_match` with a hint to re-read the file and copy
    the exact text.
  - More than one occurrence without `replace_all` → failure `multiple_matches`,
    the file is left byte-identical, and the hint names the matching line numbers
    and suggests `replace_all`.
  - Exactly one occurrence, or `replace_all: true` → writes the replacement and
    returns `{ path, replacements, linesChanged, bytesWritten }`.
  - An empty `old_string` → failure `invalid_input`.
- `search` tool: input `{ pattern, ignore_case?, path?, max_results? }`.
  - The walk and the regex scan run in a dedicated worker that is terminated on
    timeout; the worker requests each file through the fs bridge and the main thread
    serves it with `WorkspaceApi.readFile`. Catastrophic backtracking therefore kills
    the worker instead of stalling the main thread, and the pattern is compiled in
    that worker. A worker timeout, default `SEARCH_TIMEOUT_MS = 5000`, returns a
    `timeout` failure envelope with a hint.
    <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
  - `pattern` is a JavaScript regular expression source. An invalid pattern →
    failure `invalid_input` with a hint.
  - A cheap pre-check in `src/workspace/search.ts` may reject an obviously
    catastrophic pattern (nested quantifiers such as `(a+)+`, `(.*)*`, and
    backreferences) before compiling as `invalid_input` with a hint. It is an early
    optimization, not the mitigation: worker termination is the mitigation of
    record.
    <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
  - Recursively walks the workspace (or the `path` subtree when supplied) and
    returns hits shaped `{ path, line, text }` with `line` 1-based.
  - `max_results` defaults to 100 and is hard-capped at 500. `maxFilesScanned`
    (default 2000) and `maxDepth` (default 20) are hard caps kept as secondary
    guards behind worker termination. The walk stops when any cap is reached and the
    result carries `truncated: true`.
    <!-- Updated: Red Team Session 1 - search hard caps -->
    <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
  - An oversized file is never materialized in the worker: the main-thread `read`
    RPC applies the 2 MiB `DEFAULT_SIZE_CAP`, and any `fs.error` for a `read` or
    `list` (oversized, unreadable, or missing) increments `filesSkipped` instead of
    failing the search.
    <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
  - Skips a binary file: a NUL byte in the first 8 KiB of decoded text means
    "binary", not "no matches". The result reports `filesScanned` and
    `filesSkipped`.
  - A per-hit `text` value is truncated to 400 characters.
  - An unreadable subtree is skipped and counted in `filesSkipped`; it does not
    fail the whole search.
- `move` tool: input `{ from, to }`. Works for a file or a directory (recursive).
  Fails closed with `conflict` if `to` already exists. Returns `{ from, to, kind,
  size }`.
- `copy` tool: same input and semantics, source is left in place. Also fails
  closed on an existing destination.
- `move` and `copy` reject a destination equal to, or a strict descendant of, the
  source with `invalid_input`, before any copy or remove runs. Without this check,
  `move(a → a/b)` copies the tree into itself and then removes the source (data
  loss), and a recursive `copy(a → a/b)` never terminates.
  <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- `move`/`copy` use a byte-stream copy primitive, so neither is bound by the text
  `DEFAULT_SIZE_CAP` and empty directories are recreated: a new `copyFile` in
  `src/workspace/fs.ts` streams `FileSystemFileHandle.getFile()` bytes into the
  destination's `createWritable()` instead of going through `readFile`/`writeFile`,
  and a directory copy recreates every directory (including empty ones) before
  copying its files.
  <!-- Updated: Red Team Session 1 - move/copy limits stated -->
  <!-- Updated: Validation Session 1 - byte-stream copy path -->
- `WorkspaceApi` gains `move`, `copy`, and `search`; `WorkspaceFs`
  (`src/workspace/fs.ts:73`) gains the same three members, and `WorkspaceFs`
  implementations must satisfy them. Every new operation routes through the
  validated helpers: `move`/`copy` validate both `from` and `to` through
  `resolveSegments` and `ensurePermission`, and `search` resolves every requested
  path through `list`/`readFile`.
  <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
- All four tools return Phase 1 envelopes and use `wrapToolExecute`.
- No new runtime dependency is added. Regex and glob work use built-ins only.

## Architecture

**`edit_file` — read, verify, then write.**

```
tool input → workspace.readFile(path)            // cap + path validation
           → planPatch(content, old, new, all)   // pure, src/workspace/patch.ts
           → { ok: true, content } → workspace.writeFile(path, content)
           → { ok: false, code, hint, lines }  → failure envelope
```

`planPatch` is pure and returns the new content plus the replacement count and the
changed line numbers, or a failure reason with the matching line numbers. The tool
layer never inspects content itself, so the same helper is unit-testable without a
filesystem.

This is deliberately a non-atomic read-modify-write. The File System Access API
offers no compare-and-swap and no atomic replace, so a concurrent external editor
can win the race. The tool reports `bytesWritten` so a stale write is visible in
the transcript. This is an accepted, documented limitation, not a hidden one.

**`search` — walk and match in a dedicated worker, killed on timeout.**
`FileWorkspaceFs.search` delegates to a per-call search runner
(`src/workspace/search-runner.ts`) that spawns a dedicated worker
(`src/workspace/search-worker.ts`), posts the pattern source, flags, and caps, and
arms a `SEARCH_TIMEOUT_MS` timer. The worker never sees the workspace handle: it
walks by posting `fs.call` messages typed as `FsCall`
(`src/sandbox/fs-bridge.ts:5`) — one `list` per directory, one `read` per
candidate file — which the runner answers on the main thread through the existing
`executeFsCall` bridge (`src/sandbox/fs-bridge.ts:11`). Only path strings and
decoded file text cross the bridge. Decoded text is probed for a NUL byte and
scanned line by line by the pure `scanText` helper (`src/workspace/search.ts`),
all inside the worker, so the main thread never runs an untrusted regex. The
main-thread `read` RPC applies `DEFAULT_SIZE_CAP`, so an oversized file surfaces
as an `fs.error` and is counted in `filesSkipped` rather than materialized in the
worker; the same `fs.error` handling covers an unreadable or missing entry. The walk
tracks `filesScanned` and current depth and
returns early once `maxResults`, `maxFilesScanned`, or `maxDepth` is reached,
reporting `truncated: true`. A cheap regex pre-check in `src/workspace/search.ts`
may reject an obviously catastrophic pattern before compile as an optimization;
the mitigation of record is that on `SEARCH_TIMEOUT_MS` expiry the runner calls
`worker.terminate()`, so a catastrophic pattern kills the worker instead of
stalling the tab, and the tool maps the timeout to a `timeout` failure envelope.
Caps are secondary guards.
<!-- Updated: Red Team Session 1 - search caps + ReDoS guard -->
<!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

The worker's messages are defined locally in `src/workspace/search-protocol.ts`
(`FsCall` outbound, `{ kind: 'search-done', ... }` inbound), so
`src/sandbox/protocol.ts` and the fs bridge are unchanged.

**`move` / `copy` — byte-stream copy over verified paths.**
`FileWorkspaceFs.stat` distinguishes file from directory. `copyFile` resolves the
source with `getFileHandle`, reads its `getFile()` blob, and streams those bytes
into the destination's `createWritable()` — the same byte path `writeFile` uses at
`src/workspace/fs.ts:166`, but without the text `DEFAULT_SIZE_CAP` and without
encoding the content as a string. A directory copy walks the source with a
depth-first directory stack, recreates every directory (including empty ones) with
`getDirectoryHandle(name, { create: true })`, and byte-copies each file into the
destination. `move` is copy-then-`remove`, so a failed copy leaves the source
intact.
<!-- Updated: Validation Session 1 - byte-stream copy path -->

Before any work, both operations reject a destination that resolves to the source
or to a strict descendant of the source as `invalid_input`. The destination
pre-check then uses `stat`: a `WorkspaceNotFoundError` means "destination free"
(and the parent is created as `writeFile` does), a successful `stat` is the
`conflict` failure, and only a `WorkspacePermissionError` is a hard failure. This
distinguishes "absent" from "unreadable" so a permission problem is never
misreported as a free destination.
<!-- Updated: Red Team Session 1 - descendant rejection + stat pre-check semantics -->

## Files to Create / Modify

Create:

- `src/workspace/patch.ts` — `planPatch`, `countOccurrences`, matching line numbers.
- `src/workspace/patch.test.ts`
- `src/workspace/search.ts` — `probeBinary`, `scanText`, hit-text truncation, and
  the cheap regex pre-check. Pure and worker-safe (no DOM, no workspace handle), so
  it imports into the search worker.
- `src/workspace/search.test.ts`
- `src/workspace/search-protocol.ts` — the search worker's local message union
  (`FsCall` outbound, `search-done` inbound) and its caps/timeout constants.
- `src/workspace/search-worker.ts` — the worker entry: walk via `list`/`read`
  `FsCall` messages, probe, match, post `search-done`.
- `src/workspace/search-runner.ts` — `createSearchRunner({ workerFactory,
  workspace, timeoutMs })` with `search(options)`: answers `fs.call` on the main
  thread through `executeFsCall`, arms the timeout, terminates the worker on
  expiry, and respawns lazily.
- `src/workspace/search-runner.test.ts` — runner behavior with an injected
  `WorkerFactory` fake (pattern per `src/sandbox/worker-factory.ts:1`).
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

Modify:

- `src/tools/types.ts` — add `WorkspaceSearchOptions`, `WorkspaceSearchHit`,
  `WorkspaceSearchResult`; extend `WorkspaceApi` with `move`, `copy`, `search`.
- `src/workspace/fs.ts` — add `move`, `copy`, and `search` to the `WorkspaceFs`
  interface (`:73`) as well as implementing them; add the `copyFile`/directory-copy
  byte-stream primitive; export `DEFAULT_MAX_SEARCH_RESULTS`,
  `DEFAULT_MAX_FILES_SCANNED`, `DEFAULT_MAX_DEPTH`, and `MAX_HIT_CHARS`
  (`SEARCH_TIMEOUT_MS` is owned by `src/workspace/search-protocol.ts`); let
  `createWorkspaceFs` (`:211`) accept an optional search
  runner / `WorkerFactory` so tests inject a fake and the browser gets the real
  worker.
  <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout; byte-stream copy path -->
- `src/workspace/search.ts` — also export the cheap regex pre-check used by the
  search worker.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- `src/tools/builtin/workspace.ts` — add `edit_file`, `search`, `move`, `copy` to
  `NAMES` and implement them with envelopes.
- `src/workspace/fs.test.ts` — search (via an injected fake runner), move, copy
  coverage, including descendant rejection, byte-stream copy of a file above
  `DEFAULT_SIZE_CAP`, an empty-directory copy, and the cap/truncation cases.
  <!-- Updated: Red Team Session 1 - descendant rejection -->
  <!-- Updated: Validation Session 1 - byte-stream copy path -->
- `src/workspace/search.test.ts` — the pure-helper and pre-check cases.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- `src/tools/builtin/workspace.test.ts` — the four new tools.
- `src/sandbox/manager.test.ts`, `src/sandbox/js-runner.test.ts`,
  `src/sandbox/py-runner.test.ts` — extend the inline `WorkspaceApi` fakes with
  `move`, `copy`, `search`.
- `src/session/workspace-state.test.ts:9` — extend `fakeFs()` with `move`, `copy`,
  `search` so it still satisfies `WorkspaceFs`.
  <!-- Updated: Red Team Session 1 - complete fake/consumer list -->

Do not modify: `src/chat/**`, `src/sandbox/*.ts` implementation files,
`src/skills/**`, `src/vault/**`, `src/ui/**`.

## Test Plan

Unit — `src/workspace/patch.test.ts`

- Zero occurrences returns a `no_match` result with no content.
- Multiple occurrences without `replace_all` returns `multiple_matches` and the
  matching line numbers, and does not produce content.
- Exactly one occurrence replaces it and returns `replacements: 1`.
- `replace_all: true` replaces every occurrence and reports the count.
- Overlapping-looking input (`'aa'` in `'aaa'`) counts non-overlapping occurrences
  and the result is deterministic.
- An empty `old_string` is rejected without scanning.
- A `new_string` identical to `old_string` is reported as zero effective changes.
- CRLF content round-trips without introducing or losing line endings.

Unit — `src/workspace/search.test.ts`

- `probeBinary` is true for text with a NUL byte in the first 8 KiB and false for
  plain text.
- `scanText` finds all matches with correct 1-based line numbers.
- `scanText` respects `maxResults` and reports truncation.
- `scanText` truncates a long hit's `text` to 400 characters.
- A multiline-looking pattern does not produce a match across line boundaries
  (scanning is per line).
- The cheap pre-check rejects `(a+)+`, `(.*)*`, and a backreference pattern before
  compilation, and accepts ordinary patterns such as `foo|bar` and `TODO`.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

Unit — `src/workspace/search-runner.test.ts` (injected `WorkerFactory` fake)

- A `search-done` message resolves with the worker's hits and counters.
- A `list`/`read` `FsCall` from the worker is answered by the injected workspace,
  and the result is posted back to the worker rather than resolved as the search.
- On `SEARCH_TIMEOUT_MS` expiry the runner calls `worker.terminate()` and rejects
  with a timeout, and no result from the killed worker is accepted afterward.
- A worker that dies before posting `search-done` is reported as a failure, not a
  hang, and the next `search` call spawns a fresh worker.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

Unit — `src/workspace/fs.test.ts`

- `search` finds a pattern in a nested file and returns root-relative `path` plus
  a 1-based `line`.
- `search` counts a file above `DEFAULT_SIZE_CAP` in `filesSkipped` (the
  main-thread `read` RPC returns an `fs.error`) without throwing.
- `search` skips a NUL-byte file and still returns hits from text files.
- `search` stops at `maxResults` and reports `truncated: true`.
- `search` stops at `maxFilesScanned` and at `maxDepth`, reporting `truncated: true`
  in each case.
  <!-- Updated: Red Team Session 1 - search hard caps -->
- `search` with a `path` subtree scans only that subtree.
- `copy` duplicates a file and leaves the source; `copy` on a directory copies
  nested files.
- `move` relocates a file and removes the source; `move` on a directory relocates
  the tree.
- `move` and `copy` to an existing destination return a `conflict` failure and
  leave both entries untouched.
- `move(a → a/b)`, `move(a → a)`, and `copy(a → a/b)` each fail `invalid_input`
  before any write, and the source survives intact (the regression that motivates
  the check).
  <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- `copy` of a source file above `DEFAULT_SIZE_CAP` succeeds and reproduces the
  bytes exactly, proving the copy path does not use the text cap.
- A directory copy recreates an empty subdirectory alongside its files.
  <!-- Updated: Red Team Session 1 - move/copy limits stated -->
  <!-- Updated: Validation Session 1 - byte-stream copy path -->
- `move` and `copy` with `..`, a backslash, or a drive-letter path throw
  `WorkspacePathError` for either argument.
- `move` and `copy` against a permission-denied handle throw
  `WorkspacePermissionError`.

Unit — `src/tools/builtin/workspace.test.ts`

- `edit_file` on a unique match rewrites the file; reading it back shows the new
  content.
- `edit_file` with a duplicated `old_string` returns `{ ok: false, code:
  'multiple_matches' }` and the file is unchanged.
- `edit_file` with `replace_all: true` replaces every occurrence.
- `edit_file` on a missing file returns `not_found`.
- `search` returns hits with `path:line:text`-equivalent fields and a
  `truncated` flag; an invalid regex returns `invalid_input` with a hint.
- `move` and `copy` return the destination descriptor; a second `move` to the same
  destination returns `conflict`; `move(a → a/b)` returns `invalid_input`.
  <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- `search` over a capped tree reports `truncated: true` when `maxFilesScanned` or
  `maxDepth` stops the walk; a catastrophic pattern returns `invalid_input` from the
  pre-check or `timeout` when the worker is terminated.
  <!-- Updated: Red Team Session 1 - search hard caps -->
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- The tool set built from `workspaceToolProvider` contains exactly the ten names
  in sorted order: `copy`, `edit_file`, `list_dir`, `make_dir`, `move`,
  `read_file`, `remove`, `search`, `stat`, `write_file`.

Manual — browser-only, recorded under
`plans/260919-1821-harness-tools/reports/` with date, build hash, and observed result

- A real `Worker`-backed `search` returns hits and, on a deliberately catastrophic
  pattern, terminates the worker and returns the `timeout` envelope without freezing
  the tab.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

Regression

- `src/sandbox/*.test.ts` passes with the extended inline fakes.
- `src/session` composition still registers the provider once; no engine change.

## Implementation Steps

1. Write `src/workspace/patch.ts` with `countOccurrences(content, needle):
   number[]` returning the line numbers of non-overlapping matches, and
   `planPatch(content, oldString, newString, replaceAll)` returning a discriminated
   result. Write `src/workspace/patch.test.ts` and run it.
2. Write `src/workspace/search.ts` with `probeBinary(text)`, `scanText(text,
   matcher, maxResults, remaining)` returning `{ hits, truncated }`, the
   `MAX_HIT_CHARS` truncation, and the cheap regex pre-check. Keep it pure and
   worker-safe. Write `src/workspace/search.test.ts` and run it.
   <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
3. Extend `src/tools/types.ts` with `WorkspaceSearchOptions`,
   `WorkspaceSearchHit`, `WorkspaceSearchResult`, and the three new
   `WorkspaceApi` members; add the same three to the `WorkspaceFs` interface in
   `src/workspace/fs.ts`.
   <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
4. Write `src/workspace/search-protocol.ts` (`FsCall` outbound, `search-done`
   inbound, `SEARCH_TIMEOUT_MS`) and `src/workspace/search-worker.ts`: receive the
   pattern/caps, walk with `list` `FsCall`s and read candidates with `read`
   `FsCall`s, probe for NUL, run `scanText`, stop at the caps, and post
   `search-done`. Write `src/workspace/search-runner.ts`: spawn the worker, answer
   each `fs.call` on the main thread through `executeFsCall`
   (`src/sandbox/fs-bridge.ts:11`), arm the timeout, call `worker.terminate()` on
   expiry, and respawn lazily. Make `FileWorkspaceFs.search` delegate to the
   runner. Write `src/workspace/search-runner.test.ts` with an injected fake
   `WorkerFactory` and run it.
   <!-- Updated: Red Team Session 1 - search hard caps -->
   <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
5. Implement the `copyFile` byte-stream primitive in `src/workspace/fs.ts`: read
   the source `getFile()` blob and stream it into the destination
   `createWritable()`, with no text `DEFAULT_SIZE_CAP`. Implement
   `FileWorkspaceFs.copy` and `FileWorkspaceFs.move` on top of it: copy files
   through `copyFile`, recreate every directory (including empty ones) through
   `directoryFor`/`getDirectoryHandle(..., { create: true })`, and reject a
   destination equal to or a strict descendant of the source before any work. Read
   the destination pre-check as: `WorkspaceNotFoundError` → free, successful
   `stat` → conflict, `WorkspacePermissionError` → hard failure.
   <!-- Updated: Red Team Session 1 - descendant rejection + stat pre-check semantics -->
   <!-- Updated: Validation Session 1 - byte-stream copy path -->
6. Update `src/tools/builtin/workspace.ts`: extend `NAMES`, add the four input
   schemas, implement the four `execute` bodies with `wrapToolExecute`, and map
   `planPatch` failures to `no_match` / `multiple_matches` / `invalid_input`
   envelopes with hints. Map a successful `stat` on the destination to `conflict`,
   a descendant/self destination to `invalid_input`, and a search-runner timeout to
   `timeout`; do not map an unreadable destination to `conflict`.
   <!-- Updated: Red Team Session 1 - stat pre-check semantics -->
   <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
7. Update `src/workspace/fs.test.ts` and
   `src/tools/builtin/workspace.test.ts`; add the three new methods to the three
   sandbox inline fakes and to `fakeFs()` in `src/session/workspace-state.test.ts`.
   <!-- Updated: Red Team Session 1 - complete fake/consumer list -->
8. Run `pnpm test`, then `pnpm lint` and `pnpm build` (a public model-facing
   contract changed).

## Todo

- [ ] `src/workspace/patch.ts` + test
- [ ] `src/workspace/search.ts` + test (pure helpers + cheap pre-check)
- [ ] `src/workspace/search-protocol.ts`, `search-worker.ts`, `search-runner.ts` +
      runner test; `FileWorkspaceFs.search` delegates to the runner, which
      terminates the worker on timeout
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] `WorkspaceApi` gains `move`, `copy`, `search`
- [ ] `WorkspaceFs` interface gains the same three members
      <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
- [ ] `copyFile` byte-stream primitive; `FileWorkspaceFs.copy`/`move` use it, are
      not bound by the text cap, and recreate empty directories
      <!-- Updated: Validation Session 1 - byte-stream copy path -->
- [ ] `FileWorkspaceFs.move` and `copy` reject a self/descendant destination as
      `invalid_input` and fail closed with `conflict` only on a successful `stat`
      <!-- Updated: Red Team Session 1 - descendant rejection + stat semantics -->
- [ ] `edit_file` in `workspaceToolProvider` with `no_match` / `multiple_matches`
      / `invalid_input` failures and hints
- [ ] `search` tool with `invalid_input` on a bad regex, `timeout` on worker
      termination, and bounded results
      <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] `move` and `copy` tools with `conflict` on an existing destination
- [ ] `fs.test.ts` and `workspace.test.ts` updated, including descendant,
      large-file/empty-directory copy, and truncation cases
- [ ] Three sandbox inline `WorkspaceApi` fakes and `fakeFs()` in
      `src/session/workspace-state.test.ts` extended
      <!-- Updated: Red Team Session 1 - complete fake/consumer list -->
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [ ] `edit_file` on a unique match rewrites the file; on a duplicate without
      `replace_all` it returns `multiple_matches` AND the file is byte-identical,
      proven by reading it back in the test.
- [ ] `edit_file` reports the matching line numbers in the failure hint.
- [ ] `search` runs in a worker that is terminated on timeout, returns at most
      `max_results` hits, never materializes a file above `DEFAULT_SIZE_CAP`, and
      skips NUL-byte files while still returning hits from text files in the same
      tree.
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] `search` stops at `maxFilesScanned` and `maxDepth` and reports `truncated`,
      and a catastrophic pattern ends in worker termination rather than a stalled
      tab.
      <!-- Updated: Red Team Session 1 - search hard caps + ReDoS heuristic guard -->
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] An invalid `search` pattern returns `invalid_input` with a hint instead of
      throwing; a terminated search run returns `timeout` with a hint.
      <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] `move` and `copy` work for files and nested directories, and refuse to
      overwrite an existing destination with `conflict`.
- [ ] `move` and `copy` reject a self or descendant destination as `invalid_input`
      before any write, leaving the source intact.
      <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- [ ] A `copy` of a file above the 2 MiB text cap reproduces the bytes exactly, and
      a directory copy recreates an empty subdirectory; both are exercised by tests
      and stated in the tool description.
      <!-- Updated: Red Team Session 1 - move/copy limits stated -->
      <!-- Updated: Validation Session 1 - byte-stream copy path -->
- [ ] Every path-based test still proves traversal rejection and permission-denied
      handling for the new operations.
- [ ] The `WorkspaceApi` and `WorkspaceFs` changes are additive at the call site: no
      existing one-argument `list` caller changed, and no implementation was removed.
      <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| `edit_file` read-modify-write races an external editor and silently clobbers a change | Medium × Medium | Accepted, documented limitation (no compare-and-swap in the API). The tool reports `bytesWritten` and the failure hint tells the model to re-read on `no_match`; `multiple_matches` never writes. |
| A crafted regex causes catastrophic backtracking | Low × High | The regex scan runs in a dedicated worker that is terminated on `SEARCH_TIMEOUT_MS` expiry, so backtracking kills the worker instead of the tab. `maxFilesScanned`/`maxDepth`/the hit cap and the main-thread text cap are secondary guards; the cheap pre-check is an optimization, not the mitigation. <!-- Updated: Red Team Session 1 - ReDoS heuristic guard + search hard caps --> <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout --> |
| A recursive search stalls the tab on a very large workspace | Medium × Medium | The walk and the match run off the main thread in the search worker; the main thread only answers one `list`/`read` RPC at a time, so it never blocks on the scan. `maxFilesScanned`/`maxDepth` caps and the hit cap bound the walk, and the main-thread `readFile` size gate rejects oversized files. <!-- Updated: Red Team Session 1 - search hard caps --> <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout --> |
| `move`/`copy` into a descendant destroys or duplicates the source | High × High | Both operations reject a destination equal to or a strict descendant of the source as `invalid_input` before any work, with tests for `move(a → a/b)`, `move(a → a)`, and `copy(a → a/b)`. <!-- Updated: Red Team Session 1 - descendant destination rejected --> |
| A destination `stat` fails with `WorkspacePermissionError` and is misread as "free" | Medium × Medium | Only `WorkspaceNotFoundError` means free; a successful `stat` is `conflict`; `WorkspacePermissionError` is a hard failure. Tests cover all three. <!-- Updated: Red Team Session 1 - stat pre-check semantics --> |
| Recursive `copy`/`move` on a huge directory is slow or partially completes | Medium × Low | Composition is copy-then-remove, so the source survives a failed copy; the copy streams bytes rather than buffering text, and the failure envelope names the path that failed. Not transactional, and stated as such. <!-- Updated: Validation Session 1 - byte-stream copy path --> |
| Adding three required members to `WorkspaceApi` breaks an implementer | High × Low | All four implementers are listed; the three fake sites are updated in this phase and `pnpm test` proves it. |
| NUL-byte sniffing misclassifies a UTF-16 text file as binary | Low × Low | Accepted: UTF-16 is rare in source trees and the file is reported in `filesSkipped`, so nothing is silently lost. |
| `search` hit `text` truncation hides the matched text | Low × Low | The cap is 400 characters and the match is found by line scan, so a hit is never reported without its line; long-line truncation is documented. |

**Rollback.** Revert this phase's files and the `WorkspaceApi` additions. Phase 1's
`list` extension is independent, so the revert leaves a working tool surface.
Nothing is persisted, so no data rollback is needed. The sandbox fake updates
revert with the interface.

## Security Considerations

- All four operations route through `resolveSegments` and `ensurePermission`.
  `search` resolves every child through the validated `WorkspaceApi.list`/`readFile`
  on the main thread, so it cannot walk outside the granted root even if a
  symlink-like entry appears.
- `search` matches in a worker and returns only matching lines, never whole files,
  so a large file cannot flood the model context through this path. File text does
  cross into the search worker; the workspace handle and the vault `CryptoKey` do
  not.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- `max_results` and `MAX_HIT_CHARS` bound the model-facing payload, which limits
  the injection surface of repository content reaching the model.
- `move` and `copy` fail closed on an existing destination and refuse a
  self/descendant destination before writing; they never silently destroy or
  recursively duplicate the source.
  <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- The cheap regex pre-check rejects a known catastrophic pattern, but it is a
  heuristic on untrusted model input, not a proof; the mitigation of record is
  worker termination on timeout, so a pattern the pre-check misses cannot stall the
  tab. The residual risk is recorded as accepted.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- `edit_file` writes only through the validated `writeFile`, so it inherits the
  cap and the parent-directory creation rules.
- The search worker reuses the existing `fs.call`/`fs.result`/`fs.error` message
  kinds through `executeFsCall`, so no new bridge kind is introduced and the
  `CryptoKey` boundary is unchanged.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

## Next Steps

Phase 3 changes the sandbox lifecycle only. It does not touch the workspace layer,
so Phase 2's API additions are stable when the runner tests are updated for session
reuse.
