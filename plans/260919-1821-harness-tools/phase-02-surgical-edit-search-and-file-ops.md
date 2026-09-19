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
- Search guidance: `research/researcher-02-sandbox-persistence.md` §4 (walk with
  `values()`, batch `getFile()` rather than awaiting sequentially, use
  `Blob.size` to reject before materializing, sniff bytes rather than trusting
  `Blob.type`).
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
  - `pattern` is a JavaScript regular expression source, compiled on the main
    thread. An invalid pattern → failure `invalid_input` with a hint.
  - Before compiling, a regex safety heuristic rejects a catastrophic-backtracking
    pattern (nested quantifiers such as `(a+)+`, `(.*)*`, and backreferences) as
    `invalid_input` with a hint. This is a heuristic guard, not a sandbox; it exists
    because the scan runs synchronously on the main thread.
    <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
  - Recursively walks the workspace (or the `path` subtree when supplied) and
    returns hits shaped `{ path, line, text }` with `line` 1-based.
  - `max_results` defaults to 100 and is hard-capped at 500. `maxFilesScanned`
    (default 2000) and `maxDepth` (default 20) are hard caps with defaults. The walk
    stops when any cap is reached and the result carries `truncated: true`.
    <!-- Updated: Red Team Session 1 - search hard caps -->
  - Skips any file whose `File.size` exceeds `DEFAULT_SIZE_CAP`.
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
- Explicit `move`/`copy` limits (documented, not hidden): a source file above the
  2 MiB `DEFAULT_SIZE_CAP` (`src/workspace/fs.ts:24`) fails with `limit_exceeded`
  because the copy is composed from the capped `readFile`/`writeFile`; and a
  text-based copy recreates files and directories but NOT empty directories.
  <!-- Updated: Red Team Session 1 - move/copy limits stated -->
- `WorkspaceApi` gains `move`, `copy`, and `search`; `WorkspaceFs`
  (`src/workspace/fs.ts:73`) gains the same three members, and `WorkspaceFs`
  implementations must satisfy them. Every new operation calls `resolveSegments`
  and `ensurePermission` for both paths.
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

**`search` — walk on the main thread, never through the fs bridge.**
`FileWorkspaceFs.search` resolves the start directory through `directoryFor`
(`src/workspace/fs.ts:99`), then walks with an explicit stack of
`FileSystemDirectoryHandle` values using `values()`. File children are read in
batches of at most `SEARCH_CONCURRENCY = 8` using `getFile()`, matching Chrome's
guidance to resolve `getFile()` promises together rather than awaiting each one
(`research/researcher-02-sandbox-persistence.md` §4). Each file is gated on
`File.size` before any read. Decoded text is probed for a NUL byte, then scanned
line by line by the pure `scanText` helper (`src/workspace/search.ts`). The walk
tracks `filesScanned` and current depth and returns early once `maxResults`,
`maxFilesScanned`, or `maxDepth` is reached, reporting `truncated: true`. The
`pattern` is compiled only after the safety heuristic in
`src/workspace/search.ts` accepts it. The scan is synchronous on the main thread;
the residual ReDoS risk is bounded by the heuristic, the byte cap, and the walk
caps, and is recorded rather than claimed to be eliminated.
<!-- Updated: Red Team Session 1 - search caps + ReDoS guard -->

`search` never routes through `executeFsCall` (`src/sandbox/fs-bridge.ts:11`),
which returns `JSON.stringify(entries)` per call and would be chatty and
allocation-heavy for a recursive scan.

**`move` / `copy` — composed from existing validated primitives.**
`FileWorkspaceFs.stat` distinguishes file from directory. A file copy reads through
the capped `readFile` and writes through `writeFile` (which creates parents). A
directory copy walks the source with the same stack used by `search` and copies
each file into the destination. `move` is copy-then-`remove`, so a failed copy
leaves the source intact.

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
- `src/workspace/search.ts` — `probeBinary`, `scanText`, hit-text truncation.
- `src/workspace/search.test.ts`

Modify:

- `src/tools/types.ts` — add `WorkspaceSearchOptions`, `WorkspaceSearchHit`,
  `WorkspaceSearchResult`; extend `WorkspaceApi` with `move`, `copy`, `search`.
- `src/workspace/fs.ts` — add `move`, `copy`, and `search` to the `WorkspaceFs`
  interface (`:73`) as well as implementing them; export `SEARCH_CONCURRENCY`,
  `DEFAULT_MAX_SEARCH_RESULTS`, `DEFAULT_MAX_FILES_SCANNED`, `DEFAULT_MAX_DEPTH`,
  `MAX_HIT_CHARS`.
  <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
- `src/workspace/search.ts` — also export the regex safety heuristic used by
  `FileWorkspaceFs.search`.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- `src/tools/builtin/workspace.ts` — add `edit_file`, `search`, `move`, `copy` to
  `NAMES` and implement them with envelopes.
- `src/workspace/fs.test.ts` — search, move, copy coverage, including descendant
  rejection and the cap/truncation cases.
  <!-- Updated: Red Team Session 1 - descendant rejection -->
- `src/workspace/search.test.ts` — the heuristic cases.
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
- The safety heuristic rejects `(a+)+`, `(.*)*`, and a backreference pattern before
  compilation, and accepts ordinary patterns such as `foo|bar` and `TODO`.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->

Unit — `src/workspace/fs.test.ts`

- `search` finds a pattern in a nested file and returns root-relative `path` plus
  a 1-based `line`.
- `search` skips a file above `DEFAULT_SIZE_CAP` and counts it in
  `filesSkipped`, without throwing.
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
- A `move`/`copy` source above `DEFAULT_SIZE_CAP` fails `limit_exceeded`; a
  directory copy recreates regular files but not an empty directory, which is the
  documented limitation.
  <!-- Updated: Red Team Session 1 - move/copy limits stated -->
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
  `maxDepth` stops the walk, and a catastrophic pattern returns `invalid_input`.
  <!-- Updated: Red Team Session 1 - search hard caps -->
- The tool set built from `workspaceToolProvider` contains exactly the ten names
  in sorted order: `copy`, `edit_file`, `list_dir`, `make_dir`, `move`,
  `read_file`, `remove`, `search`, `stat`, `write_file`.

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
   `MAX_HIT_CHARS` truncation, and the regex safety heuristic. Write
   `src/workspace/search.test.ts` and run it.
   <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
3. Extend `src/tools/types.ts` with `WorkspaceSearchOptions`,
   `WorkspaceSearchHit`, `WorkspaceSearchResult`, and the three new
   `WorkspaceApi` members; add the same three to the `WorkspaceFs` interface in
   `src/workspace/fs.ts`.
   <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
4. Implement `FileWorkspaceFs.search` in `src/workspace/fs.ts`: an explicit
   directory stack, a fixed-size read batch, the size gate before `getFile()`, the
   NUL probe, the per-line scan, and early return once `maxResults`,
   `maxFilesScanned`, or `maxDepth` is reached. Reuse `resolveSegments`,
   `directoryFor`, and `mapDomError`; an unreadable subtree is counted and skipped,
   but a traversal path still throws.
   <!-- Updated: Red Team Session 1 - search hard caps -->
5. Implement `FileWorkspaceFs.copy` and `FileWorkspaceFs.move` by composing
   `stat`, `readFile`, `writeFile`, the directory stack, and `remove`. Reject a
   destination equal to or a strict descendant of the source before any work. Read
   the destination pre-check as: `WorkspaceNotFoundError` → free, successful
   `stat` → conflict, `WorkspacePermissionError` → hard failure.
   <!-- Updated: Red Team Session 1 - descendant rejection + stat pre-check semantics -->
6. Update `src/tools/builtin/workspace.ts`: extend `NAMES`, add the four input
   schemas, implement the four `execute` bodies with `wrapToolExecute`, and map
   `planPatch` failures to `no_match` / `multiple_matches` / `invalid_input`
   envelopes with hints. Map a successful `stat` on the destination to `conflict`
   and a descendant/self destination to `invalid_input`; do not map an unreadable
   destination to `conflict`.
   <!-- Updated: Red Team Session 1 - stat pre-check semantics -->
7. Update `src/workspace/fs.test.ts` and
   `src/tools/builtin/workspace.test.ts`; add the three new methods to the three
   sandbox inline fakes and to `fakeFs()` in `src/session/workspace-state.test.ts`.
   <!-- Updated: Red Team Session 1 - complete fake/consumer list -->
8. Run `pnpm test`, then `pnpm lint` and `pnpm build` (a public model-facing
   contract changed).

## Todo

- [ ] `src/workspace/patch.ts` + test
- [ ] `src/workspace/search.ts` + test
- [ ] `WorkspaceApi` gains `move`, `copy`, `search`
- [ ] `WorkspaceFs` interface gains the same three members
      <!-- Updated: Red Team Session 1 - WorkspaceFs interface extended too -->
- [ ] `FileWorkspaceFs.search` with size gate, NUL probe, batching, `maxResults`,
      `maxFilesScanned`, `maxDepth`, and the regex safety heuristic
      <!-- Updated: Red Team Session 1 - search hard caps + ReDoS heuristic guard -->
- [ ] `FileWorkspaceFs.move` and `copy` reject a self/descendant destination as
      `invalid_input` and fail closed with `conflict` only on a successful `stat`
      <!-- Updated: Red Team Session 1 - descendant rejection + stat semantics -->
- [ ] `edit_file` in `workspaceToolProvider` with `no_match` / `multiple_matches`
      / `invalid_input` failures and hints
- [ ] `search` tool with `invalid_input` on a bad or catastrophic regex and bounded
      results
      <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- [ ] `move` and `copy` tools with `conflict` on an existing destination
- [ ] `fs.test.ts` and `workspace.test.ts` updated, including descendant and
      limit/truncation cases
- [ ] Three sandbox inline `WorkspaceApi` fakes and `fakeFs()` in
      `src/session/workspace-state.test.ts` extended
      <!-- Updated: Red Team Session 1 - complete fake/consumer list -->
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [ ] `edit_file` on a unique match rewrites the file; on a duplicate without
      `replace_all` it returns `multiple_matches` AND the file is byte-identical,
      proven by reading it back in the test.
- [ ] `edit_file` reports the matching line numbers in the failure hint.
- [ ] `search` returns at most `max_results` hits, never reads a file above
      `DEFAULT_SIZE_CAP`, and skips NUL-byte files while still returning hits from
      text files in the same tree.
- [ ] `search` stops at `maxFilesScanned` and `maxDepth` and reports `truncated`,
      and a catastrophic pattern is rejected before compilation.
      <!-- Updated: Red Team Session 1 - search hard caps + ReDoS heuristic guard -->
- [ ] An invalid or catastrophic `search` pattern returns `invalid_input` with a
      hint instead of throwing.
      <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- [ ] `move` and `copy` work for files and nested directories, and refuse to
      overwrite an existing destination with `conflict`.
- [ ] `move` and `copy` reject a self or descendant destination as `invalid_input`
      before any write, leaving the source intact.
      <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- [ ] The 2 MiB source limit and the empty-directory limitation of a text-based copy
      are exercised by tests and stated in the tool description.
      <!-- Updated: Red Team Session 1 - move/copy limits stated -->
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
| A crafted regex causes catastrophic backtracking on the main thread | Low × High | A safety heuristic rejects nested-quantifier and backreference patterns before compile; the walk is capped by `maxResults`/`maxFilesScanned`/`maxDepth` and each file is byte-capped. Residual risk is bounded by these guards and recorded, because a synchronous `RegExp` test cannot be preempted. <!-- Updated: Red Team Session 1 - ReDoS heuristic guard + search hard caps --> |
| A recursive search stalls the tab on a very large workspace | Medium × Medium | Bounded read concurrency, an explicit directory stack (no deep recursion), `maxFilesScanned`/`maxDepth` caps, the hit cap, and the size gate. <!-- Updated: Red Team Session 1 - search hard caps --> |
| `move`/`copy` into a descendant destroys or duplicates the source | High × High | Both operations reject a destination equal to or a strict descendant of the source as `invalid_input` before any work, with tests for `move(a → a/b)`, `move(a → a)`, and `copy(a → a/b)`. <!-- Updated: Red Team Session 1 - descendant destination rejected --> |
| A destination `stat` fails with `WorkspacePermissionError` and is misread as "free" | Medium × Medium | Only `WorkspaceNotFoundError` means free; a successful `stat` is `conflict`; `WorkspacePermissionError` is a hard failure. Tests cover all three. <!-- Updated: Red Team Session 1 - stat pre-check semantics --> |
| A `move`/`copy` source above 2 MiB fails, or an empty directory is not recreated | Medium × Low | Both are explicit, documented limitations: the cap is inherited from `readFile`/`writeFile` and the failure code is `limit_exceeded`; a text-based copy recreates files, not empty directories. Stated in the tool description and tests. <!-- Updated: Red Team Session 1 - move/copy limits stated --> |
| Recursive `copy`/`move` on a huge directory is slow or partially completes | Medium × Low | Composition is copy-then-remove, so the source survives a failed copy; the failure envelope names the path that failed. Not transactional, and stated as such. |
| Adding three required members to `WorkspaceApi` breaks an implementer | High × Low | All four implementers are listed; the three fake sites are updated in this phase and `pnpm test` proves it. |
| NUL-byte sniffing misclassifies a UTF-16 text file as binary | Low × Low | Accepted: UTF-16 is rare in source trees and the file is reported in `filesSkipped`, so nothing is silently lost. |
| `search` hit `text` truncation hides the matched text | Low × Low | The cap is 400 characters and the match is found by line scan, so a hit is never reported without its line; long-line truncation is documented. |

**Rollback.** Revert this phase's files and the `WorkspaceApi` additions. Phase 1's
`list` extension is independent, so the revert leaves a working tool surface.
Nothing is persisted, so no data rollback is needed. The sandbox fake updates
revert with the interface.

## Security Considerations

- All four operations route through `resolveSegments` and `ensurePermission`.
  `search` derives every child from an already-validated directory handle, so it
  cannot walk outside the granted root even if a symlink-like entry appears.
- `search` reads file content on the main thread and returns only matching lines,
  never whole files, so a large file cannot flood the model context through this
  path.
- `max_results` and `MAX_HIT_CHARS` bound the model-facing payload, which limits
  the injection surface of repository content reaching the model.
- `move` and `copy` fail closed on an existing destination and refuse a
  self/descendant destination before writing; they never silently destroy or
  recursively duplicate the source.
  <!-- Updated: Red Team Session 1 - descendant destination rejected -->
- The regex safety heuristic blocks a known catastrophic pattern, but it is a
  heuristic on untrusted model input, not a proof; the residual ReDoS risk is
  bounded by the byte cap and walk caps and is documented as accepted.
  <!-- Updated: Red Team Session 1 - ReDoS heuristic guard -->
- `edit_file` writes only through the validated `writeFile`, so it inherits the
  cap and the parent-directory creation rules.
- No new worker message kind is introduced, so the `CryptoKey` boundary is
  unchanged, and no file content crosses a worker boundary.

## Next Steps

Phase 3 changes the sandbox lifecycle only. It does not touch the workspace layer,
so Phase 2's API additions are stable when the runner tests are updated for session
reuse.
