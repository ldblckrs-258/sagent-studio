---
title: "Chat Interface"
description: "Three-column assistant-ui shell that bridges the core chat engine to conversations, workspace, chat config, skills, tools, and sandbox panels."
status: implemented (browser gates pending)
priority: P1
effort: 50h
branch: main
tags: [feature, frontend, ui, ai]
blockedBy: []
blocks: []
created: 2026-09-19
---

# Chat Interface

## Overview

Build the chat surface for `sagent-studio` on top of the implemented core chat
engine. The app becomes a three-column shell: the left column lists conversations
grouped by workspace, the center renders the streaming thread through the vendored
assistant-ui elements, and the right edge is an icon rail whose panels cover the
workspace picker and browser, the file viewer/editor, chat configuration, skills,
tools, and the sandbox. The engine stays the only streaming and persistence path;
the UI is a bridge over `useExternalStoreRuntime`, not a second execution path.

Nothing instantiates the engine or the registries in application code today
(`src/chat/engine.ts:322` is referenced only by tests), so Phase 1 adds the
app-level session composition before any panel can be wired.

Sources of truth:

- Accepted contract and user-decided forks:
  [brainstorm report](../reports/brainstorm-260919-2129-assistant-ui-chat-interface.md).
- assistant-ui 0.15.20 integration facts and pitfalls P1-P13:
  [research 01](./research/researcher-01-assistant-ui-integration.md).
- Design tokens, component conventions, state shapes, test reality, and the
  per-panel reusable-API table:
  [research 02](./research/researcher-02-ui-patterns-and-testing.md).
- Predecessor engine:
  [Core Chat Engine](../260919-0828-core-chat-engine/plan.md) (implemented).

## Goals

| # | Goal | Phase | Priority |
|---|------|-------|----------|
| 1 | Chat UI: streaming markdown, reasoning, tool calls, composer bound to engine status | 1 | P1 |
| 2 | Message editing and rerun through engine semantics, with cancel and visible errors | 1 | P1 |
| 3 | Conversation list grouped by workspace, with create/switch/rename/delete | 2 | P1 |
| 4 | Workspace folder picker with restore and permission re-grant | 3 | P1 |
| 5 | Workspace browser: lazy directory tree | 3 | P1 |
| 6 | File viewer and editor: open, dirty tracking, save, error mapping | 3 | P1 |
| 7 | Chat config UI: thread params, providers, vault settings | 4 | P1 |
| 8 | Skills management: list, enable, import `SKILL.md`, edit, remove | 5 | P2 |
| 9 | Tool/function management: builtin availability, user tool CRUD, persisted enablement | 5 | P2 |
| 10 | Sandbox management: config, runner status, JS/Python scratchpad console | 6 | P2 |
| 11 | Right icon rail with keyboard-accessible expand/collapse and per-session panel state | 1 | P1 |

## Contract

**Outcome.** A working chat workspace UI. Left: conversations grouped by
workspace, with create/switch/rename/delete. Center: streaming markdown,
reasoning, tool calls, composer, user-message edit, assistant rerun. Right: an
icon rail expanding panels for the workspace picker, workspace browser, file
viewer/editor, chat config (thread config + providers + vault), skills
management, tool/function management, and sandbox management (config + status +
scratchpad console).

**Constraints.**

- Browser-only; matches the existing vault/Dexie/WebCrypto architecture.
- The engine remains the only streaming and persistence path. The UI must not
  duplicate or bypass `src/chat/engine.ts`, `src/chat/reducer.ts`, or
  `src/chat/persistence.ts`.
- Bind through `useExternalStoreRuntime` with an app-owned message array. The
  installed `@assistant-ui/react@0.15.20` has no `useChatRuntime`.
- Encrypted persistence only; never render provider API keys or vault material.
  `SecretField` (`src/ai/secret-field.tsx:13`) is the only sanctioned key display.
- The house design system is authoritative: `src/index.css` `@theme` tokens and
  `src/ui/primitives.tsx`. No `docs/design-guidelines.md` exists.
- Text files only, current 2 MB `WorkspaceFs` cap (`src/workspace/fs.ts:24`).
- `pnpm lint`, `pnpm test`, and `pnpm build` stay green. Vitest runs in `node`
  with `fake-indexeddb` (`vitest.config.ts:4-9`); new UI logic stays testable
  outside the browser, and browser-only behaviour goes to the journal artifact.
- Vault lock must abort runs and clear the chat UI. `src/chat/store.ts:71`
  already subscribes and clears; the UI must not re-implement it beyond reacting
  to `activeThreadId === null`.

**Non-goals.**

- Attachments, vision, voice/dictation, audio messages.
- RAG/TypeSafe (Plan 2); MCP client.
- Provider/vault settings redesign beyond relocating them into the shell.
- New crypto or envelope format changes; binary file editing.
- Cross-session branch history; a persisted branch tree.
- Firefox/Safari folder parity beyond a feature-detected degradation.
- Mobile-app parity beyond a usable responsive collapse.

**Acceptance criteria.** Numbered to match the phase that owns them.

1. Left column groups conversations by workspace (plus a "No workspace" group),
   and create/switch/rename/delete survive reload. (Phase 2)
2. Center renders streamed markdown, reasoning, and tool calls through the
   vendored elements; composer send/cancel is bound to engine status. (Phase 1)
3. Editing a user message and rerunning an assistant message go through engine
   semantics; streaming, cancel, and error states are visible and correct.
   (Phase 1)
4. The right rail expands/collapses panels via icon buttons, keyboard accessible,
   with per-session persisted open/active state. (Phase 1)
5. Workspace picker picks a folder, re-grants permission after reload, and
   restores the handle; a denied re-grant surfaces an actionable state. (Phase 3)
6. Workspace browser lists the tree; the viewer/editor opens a file, tracks dirty
   state, and saves through `WorkspaceFs.writeFile`. (Phase 3)
7. Chat config edits every `ThreadConfig` field, including provider/model, params,
   `maxSteps`, and per-thread enabled skills; invalid input is blocked with field
   errors and never reaches the engine. (Phase 4)
8. Skills panel lists vault and workspace skills, toggles enablement, imports a
   `SKILL.md`, edits, and removes. (Phase 5)
9. Tools panel lists builtin and user tools with availability, persists
   enable/disable, and creates/edits/deletes `http` and `sandbox-js` tools with
   schema validation. (Phase 5)
10. Sandbox panel shows runner availability, persists default timeouts and
    enablement, and offers a scratchpad console that runs JS/Python and shows
    stdout/result/errors. (Phase 6)
11. All gates pass; vault lock aborts an in-flight run and clears the UI.
    (every phase)

## Key Decisions

1. **Single workspace with a snapshotted label.** One persisted handle at `db.fs`
   id `'workspace'` (`src/workspace/handle.ts:6`, `:12-18`), and a
   `workspaceName?: string` snapshot on `ChatThread` so the list can group without
   a workspace registry. Threads with no snapshot group under "No workspace".
   Evidence: brainstorm §1 (`brainstorm-260919-2129-…md:155-168`).
2. **Edit and rerun are destructive, and Phase 1 makes the edit path actually
   destructive.** Red-team finding: `reducer.editMessage`
   (`src/chat/reducer.ts:11-19`) replaces the edited message in place and keeps
   every later message, so `engine.editMessage` (`src/chat/engine.ts:163-176`)
   appends a second assistant reply and the next run is conditioned on the stale
   one. Phase 1 changes the engine edit path to truncate downstream messages
   after the edit (reusing `reducer.truncateAfter`, `src/chat/reducer.ts:27-31`)
   before starting the run, with a regression test. `onReload(parentId, config)
   -> engine.rerun(threadId, config.sourceId)` already truncates through
   `baseForMessage` (`src/chat/engine.ts:178-185`). The `BranchPicker` is removed
   from the vendored thread because replaced assistant messages survive in the
   runtime repository and would make phantom branches visible (research 01 §3, P3).
3. **Sandbox panel scope is config + status + scratchpad console.** An additive
   `Settings.sandbox` slice, a settings-driven runner factory, availability from
   `Worker` support, and a console calling `CodeRunner.run` directly. Evidence:
   brainstorm §4 (`:196-202`).
4. **One right-rail tabbed Config panel.** `App.tsx` becomes the shell; the config
   panel is tabbed Thread / Providers / Vault, mounting `ProvidersPanel`,
   `StorageWarning`, and `DataEgressNotice` unchanged. Evidence: brainstorm §5
   (`:204-209`).
5. **Runtime bridge is provider-only plus `useExternalStoreRuntime`.** Mount
   `AssistantRuntimeProvider` alone; no `AuiConfig`/`AuiProvider`; do not enable
   `unstable_enableToolInvocations`. Red-team finding: supplying `setMessages`
   alone turns on the runtime's `delete` capability (installed
   `@assistant-ui/core` `external-store-thread-runtime-core.js:166`), so
   `onDelete` must be provided rather than left unset, and it must delete through
   `reducer.deleteMessage` (`src/chat/reducer.ts:21-25`) plus `saveThread`, not
   memory-only. `setMessages` is still required for cancel durability
   (research 01 P11) and writes in-memory only. Per-thread engines share one
   global run state: Phase 1 replaces the single global `status` read with an
   active-run count so `isRunning` cannot flip mid-stream when another thread
   finishes (red-team finding 7). `isRunning` is explicit either way (research 01
   §5, P8). Evidence: `src/chat/store.ts:5`, `:60-76`.
6. **The left conversation list is app-owned.** No `adapters.threadList` and no
   `useRemoteThreadListRuntime`; the list reads the encrypted store and groups by
   the workspace snapshot. Evidence: brainstorm §3 (`:181-195`), research 01 §4.
7. **Remove `ComposerAddAttachment`, `ComposerAttachments`, and `BranchPicker`**
   from `src/components/assistant-ui/elements/thread.aui.tsx`. Dictation,
   feedback, and suggestions self-hide without adapters; do not add those
   adapters. Evidence: research 01 §6.
8. **Errors surface as an app banner above the composer**, read from
   `useChatStore.error`. The message-status projection is not used: the converter
   stays pure and store-free so it is unit-testable and does not violate the
   `useAuiState` stability rules. Evidence: research 01 §7 and P1/P2.
9. **The file viewer/editor uses Monaco, self-hosted.** User decision
   (Validation Session 1): add `monaco-editor` and render the file through it, with
   the house mono palette and the existing 2 MB cap. Monaco is bundled locally — no
   CDN loader — because the build CSP is `script-src 'self'`
   (`vite.config.ts:23`), and its editor worker is emitted by Vite and covered by
   `worker-src 'self'` (`vite.config.ts:24`). Bundle cost and worker wiring are
   recorded as phase risks (Phase 3). This supersedes the earlier plain-textarea
   decision.
10. **Tests are node-only.** Pure logic, stores, converters, reducers,
    persistence, and `renderToStaticMarkup` smoke of pure components are
    mechanically testable; runtime, interaction, worker, and picker behaviour goes
    to the journal artifact and is never claimed as automated. Evidence:
    research 02 §5; `vitest.config.ts:1-10`; `src/ai/secret-field.test.tsx` is the
    only server-render precedent.
11. **Gates stay green and secrets never render.** `pnpm lint`, `pnpm test`,
    `pnpm build`; `SecretField` is the only key display; engine error text is
    redacted (`src/chat/engine.ts:58-68`).
12. **No scope beyond the 11 traceability rows.** No MCP, attachments, voice, RAG,
    new crypto, binary editing, or branch persistence. The idle-lock minutes
    editor is dropped (Vault tab mounts existing surfaces unchanged), and
    auto-titling is dropped (titles are manual only) — both were red-team
    scope findings.
13. **One runner owner, one workspace owner, one session lifetime.** `SandboxManager`
    is the single owner of the runner pair and exposes a stable holder object so a
    settings rebuild reaches the already-registered code provider (findings 1, 9).
    `workspace-state` is the single owner of the live `WorkspaceFs`; the session
    reads it instead of holding a second slot, and `clear()` only nulls the
    in-memory reference — it never calls `clearWorkspaceHandle()` (finding 10).
    The session is created per vault unlock and disposed on lock, and
    `ToolRegistry.hydrate()` becomes skip-existing so a re-unlock is safe
    (finding 13).
14. **Sandbox availability is a provider-level gate, not a registry mutation.**
    `createCodeToolProvider` takes a runner source with `getRunners()` and
    `isEnabled()`; `isAvailable` reads the source instead of returning `true`
    (`src/tools/builtin/code.ts:32`). Phase 6 binds `isEnabled()` to
    `Settings.sandbox.enabled`, so disabling removes `run_js`/`run_python` from
    `availableNames` without `registerProvider`/removal churn (findings 1, 15).
15. **Thread title and workspace label have one write owner.** Rename and label
    patch the thread inside the vault write queue and update `useChatStore` first,
    so a concurrent engine `persist()` cannot overwrite them and a delete/rename
    race cannot resurrect a deleted row (finding 8). Titles and labels stay inside
    the encrypted envelope; `listThreads()` decrypts per row with a per-row
    try/catch so one corrupt envelope cannot hide the list (findings 8, 11).
16. **Imported `SKILL.md` files are untrusted until explicitly enabled.**
    `SkillRegistry.importSkill` currently forces `source: 'vault'` and
    `enabled: true` (`src/skills/registry.ts:98-104`), which puts an imported file
    in the trusted prompt block. Phase 5 imports as untrusted, requires an
    explicit enable, and feeds `composeSystemPrompt` the untrusted block for it.
17. **The shell collapses to drawers on narrow viewports.** User decision
    (Validation Session 1): below the shell breakpoint the left list becomes an
    overlay drawer and the right rail becomes an icon strip whose panel opens as an
    overlay, so one column of content is usable at a time. This replaces the vague
    "usable responsive collapse" wording.
18. **The sandbox scratchpad has a per-session workspace-access toggle.** User
    decision (Validation Session 1): the console is file-less by default and the
    user can opt into the workspace bridge for the current session. The manager
    already owns both runner pairs, so the toggle selects which pair the console
    calls; the toggle is session state and is not persisted.
19. **Skills and tools management is single-record only.** No bulk JSON
    export/import in this plan (Validation Session 1).

## Phases

| # | Phase | Priority | Depends on | Status |
|---|-------|----------|------------|--------|
| 1 | [Shell and Runtime Bridge](./phase-01-shell-and-runtime-bridge.md) | P1 | — | Implemented (browser gate pending) |
| 2 | [Conversations and Workspace Grouping](./phase-02-conversations-and-workspace-grouping.md) | P1 | 1 | Implemented (browser gate pending) |
| 3 | [Workspace Browser and File Editor](./phase-03-workspace-browser-and-file-editor.md) | P1 | 1 | Implemented (browser gate pending) |
| 4 | [Chat Config Panel](./phase-04-chat-config-panel.md) | P1 | 1 | Implemented (browser gate pending) |
| 5 | [Skills and Tools Panels](./phase-05-skills-and-tools-panels.md) | P2 | 1, 4 | Implemented (browser gate pending) |
| 6 | [Sandbox Panel](./phase-06-sandbox-panel.md) | P2 | 1, 5 | Implemented (browser gate pending) |

## Implementation Log

### 2026-09-19 — all phases implemented, browser gates pending

All six phases are implemented. `pnpm lint`, `pnpm test`, and `pnpm build` are
green. Every browser-only gate is recorded as `PENDING` in
[`../journals/2026-09-19-implemented-chat-interface.md`](../journals/2026-09-19-implemented-chat-interface.md)
because the implementation session had no browser and no provider key. Deviations
from the plan text, all verified against the live code:

- **Key Decision 2 / Phase 1 step 2 (destructive edit):** `reducer.editMessage`
  already truncates downstream messages (`src/chat/reducer.ts:11-19`), so the
  engine edit path was already destructive. No engine change was needed; the
  regression test already existed. The plan's premise that it kept later messages
  was factually wrong.
- **Key Decision 5 (`isRunning`):** the global active-run count was kept, and
  per-thread run counts were added on top (`activeRuns` plus
  `runningThreads`), so a second streaming thread cannot make the displayed
  thread show Cancel. `isRunning` is read from the active thread's count.
- **Error banner:** rendered by `src/ui/chat-error-banner.tsx` inside the
  composer footer, immediately above the composer, rather than in the shell.
- **Workspace state:** `src/session/workspace-state.ts` was created in Phase 1
  because the session needs the single workspace owner before Phase 3's panels.
  Phase 3 added the browser panels, tree, and editor on top of it.

Phases 2, 3, and 4 all depend on Phase 1 and touch `src/ui/shell.tsx`. They are
small, additive edits in distinct regions of one file; run them sequentially or
schedule their shell edits together to avoid the same-file conflict.

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Blocks | none | — |
| Blocked by | `project:260919-0828-core-chat-engine` | implemented |
| Blocked by | `project:260918-1209-core-infra-vault` | implemented |

Consumed interfaces (all frozen and implemented in the predecessor plans):

- `createEngine(deps)` and the method table `sendTurn`/`editMessage`/`rerun`/`undo`/`cancel`
  (`src/chat/engine.ts:322`, `:45-51`).
- `useChatStore` with `threads`, `activeThreadId`, `status`, `error`
  (`src/chat/store.ts:7-18`).
- `ThreadStore` shape `loadThread`/`saveThread`/`listThreads`/`deleteThread`
  (`src/chat/engine.ts:34-39`).
- `SkillRegistry`, `ToolRegistry`, `workspaceToolProvider`,
  `createCodeToolProvider`, `JsRunner`, `PyRunner`, `WorkspaceFs` handle helpers.
- `useVaultStore.update(patch)` as the single settings write path
  (`src/vault/store.ts:309-320`).

New cross-plan surfaces this plan adds: `src/session/session.ts`,
`src/session/session-provider.tsx`, `src/chat/convert.ts`,
`src/chat/use-chat-runtime.ts`, `src/ui/shell.tsx`, `src/chat/threads.ts`,
`src/session/workspace-state.ts`, `src/workspace/tree.ts`, `src/chat/config.ts`,
`src/sandbox/manager.ts`.

## Success Criteria

- [ ] Every phase's browser gate is recorded in
      `plans/journals/2026-09-19-implemented-chat-interface.md` with date, build
      hash, browser, command, and observed result.
- [ ] Acceptance criteria 1-11 are each evidenced by a test or a journal record;
      no browser-only behaviour is claimed as automated.
- [ ] `pnpm lint`, `pnpm test`, and `pnpm build` pass; `pnpm build` typechecks
      tests because `tsconfig.app.json:30` includes `src`.
- [ ] No test count is encoded anywhere in this plan or its output.
- [ ] No provider key, vault key, or secret appears in rendered DOM, error text,
      or the journal.
- [ ] A byte scan of the raw `db.threads` records finds no plaintext title or
      workspace label.
- [ ] `plans/README.md` indexes this plan.

## Requirements Traceability

| # | Requested feature | Owning phase | Primary evidence |
|---|-------------------|--------------|------------------|
| 1 | Workspace picker (pick, re-grant, restore) | 3 | journal pick/re-grant gate; `ensurePermission` unit tests |
| 2 | Chat UI (thread, composer, streaming) | 1 | journal streaming smoke; converter unit tests |
| 3 | Message editing and rerun | 1 | journal edit/reload gate; `onEdit`/`onReload` adapter wiring |
| 4 | Markdown streaming display | 1 | journal streaming smoke (vendored `MarkdownText`) |
| 5 | Conversation list and workspace grouping | 2 | unit tests for grouping + persistence round-trip |
| 6 | Workspace browser (tree) | 3 | `src/workspace/tree` unit tests; journal open/save gate |
| 7 | File viewer and editor | 3 | journal open/dirty/save gate; error-mapping unit tests |
| 8 | Chat config UI (thread/provider/vault) | 4 | `src/chat/config` unit tests; journal tab gate |
| 9 | Skills management | 5 | enablement round-trip unit tests; journal import gate |
| 10 | Tool/function management | 5 | save-on-toggle unit tests; journal CRUD gate |
| 11 | Sandbox management | 6 | `src/sandbox/manager` unit tests; journal JS/Python run |

## Manual Validation Artifact

Browser-only checks are recorded in
`plans/journals/2026-09-19-implemented-chat-interface.md`. The file is seeded in
Phase 1 and each phase appends its own section. Every entry records the date, the
build hash, the browser and version, the exact command used to produce the build
(normally `pnpm build && pnpm preview`), and the observed result. "Manual check"
without this record does not satisfy a phase gate.

The checks that must appear there and cannot be automated under
`environment: 'node'` (`vitest.config.ts:5`) are:

- the runtime bridge: first message streams markdown, composer swaps to Cancel
  while `status === 'streaming'`, edit and reload work, no branch picker and no
  attachment button;
- thread switching without repository bleed-through;
- workspace pick, permission re-grant, and denied re-grant;
- file open, dirty tracking, save, and size-cap error;
- config tab interaction and invalid-input blocking;
- skill import/edit and tool create/edit forms;
- a real JS and Python scratchpad run.

## Risk Summary

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| assistant-ui runtime behaviour is unverifiable in node (P12) | Browser smoke fails or renders nothing | Stop-the-line browser gate before panels are built; never claim node coverage; record the failure in the journal and escalate the wiring decision. |
| Destructive rerun leaves phantom branches in the runtime repository (P3) | `BranchPicker` was removed but branch counts still change history rendering | Removal of `BranchPicker` is the primary fix; if history still misrenders, supply a per-thread `unstable_messageRepositoryInstance` (constructor shape is UNVERIFIED, research open question 4). |
| One runtime, many conversations: repository bleed-through (P4) | Messages from thread A appear in thread B after switching | Browser gate in Phase 1; fallback is remounting `AssistantRuntimeProvider` with `key={threadId}` (loses runtime continuity), then a per-thread repository. |
| `content-visibility: auto` scroll anchoring jumps on long threads (P5) | Scroll position jumps when an off-screen message enters the viewport | The markup is app-owned; raise `[contain-intrinsic-size]` or drop `content-visibility` in `thread.aui.tsx`; record the observation. |
| React Compiler rewrites app-owned vendored patterns (P7) | Render anomalies or hook-order warnings in the thread area | Keep new components Compiler-safe; if a vendored file misbehaves, exclude it from the compiler pass rather than relaxing the app. |
| Missing settings gaps: no default provider, no sandbox slice, no skill enablement | New thread cannot send; sandbox panel has no defaults; skill toggles do not survive reload | Phase 4 uses the first configured provider deterministically and disables send with a link to the Providers tab; Phase 6 adds an additive sandbox slice; Phase 5 adds an optional skills slice with a legacy enable-all fallback. |
| Plaintext title or workspace label leaks into IndexedDB if summaries are stored carelessly | Byte scan of `db.threads` finds title text | `ThreadSummary` is derived by decrypting each envelope; titles are never written to a plaintext column; a byte-scan test is a Phase 2 gate. |
| Workspace re-grant needs a real gesture | `showDirectoryPicker` cannot be driven headlessly | Accept as a browser journal gate, as the engine plan already does; unit coverage uses `fake-handle`; the denied state must be actionable in the UI. |
| `setMessages` (runtime rewrite) diverges from engine persistence | Cancel or delete looks right until reload | `onDelete` deletes through `reducer.deleteMessage` + `saveThread`; `setMessages` is in-memory only for cancel; the Phase 1 browser gate checks delete-then-reload and cancel-then-reload. |
| Sandbox enablement cannot suppress `run_js`/`run_python` | Disabled sandbox still exposes code tools | Provider-level `isEnabled()` gate (Key Decision 14); a unit test asserts the names leave `availableNames`. |
| Runner rebuild leaks the warm Pyodide worker | Worker count grows per settings edit | One runner owner with `dispose()`; the session subscribes to `settings.sandbox` only; a test asserts no rebuild on unrelated settings writes. |
| Engine abort registrations accumulate per thread | Vault lock iterates dead engine closures | `createEngine` retains its unsubscribe and exposes `dispose()`; `disposeThread` calls it. |
| No provider-configuration UI between Phase 1 and Phase 4 | A new user cannot add a provider, create a thread, or send | Phase 1 mounts `ProvidersPanel` in the rail; Phase 4 relocates it into the Providers tab. |
| One corrupt or locked thread envelope hides the list | Sidebar empty while threads exist | Per-row decrypt/parse try/catch with an error marker; a locked vault renders the locked state. |
| A required `Settings.sandbox` or `ThreadSummary.title` breaks unlisted consumers | `pnpm build` or `pnpm test` fails | Phases list `src/vault/test-fixtures.ts`, `src/vault/store.test.ts`, `src/chat/engine.test.ts`, and the exact-shape `persistence.test.ts` assertion. |
| A rename/label write races an engine persist or a delete | Title reverts after the next turn, or a deleted thread reappears | Patch inside the queued task, update `useChatStore` first, and tombstone-guard the save (Phase 2). |
| Concurrent streams across threads corrupt `isRunning` | Cancel/Send swaps at the wrong time | Global active-run count drives `isRunning`; switching while streaming is exercised in the Phase 1 browser gate. |
| Non-destructive edit appends a duplicate reply | Two assistant replies; the new run sees the stale one | Phase 1 truncates after an edited user message before the run, with a regression test. |
| Scope creep beyond the 11 traceability rows | New dependency, adapter, or feature appears in a phase diff | The traceability table and Key Decision 12 are the ceiling; anything else is deferred to a new plan. |
| Monaco breaks the build CSP or spawns an unloadable worker | Editor blank in the built preview; CSP violation in the console | Bundle Monaco locally (no CDN), import the ESM API, and verify the editor worker under `worker-src 'self'` in the Phase 3 browser gate; fall back to a plain textarea if the worker cannot load. |
| Monaco inflates the bundle | Build size jumps and the app feels slow on first load | Lazy-load the editor route with a dynamic import so the chat surface is not blocked; record the size delta in the journal. |
| Overlay drawers trap focus or hide the composer | Keyboard navigation loses focus; chat unusable on narrow screens | Reuse the collapsible/dialog primitives for the overlay, restore focus on close, and cover it in the shell browser gate. |
| Scratchpad workspace toggle leaves access on across sessions | A later console run can read the folder without an explicit opt-in | Session-only component state, reset on panel unmount and on vault lock; never persisted to settings. |

## Red Team Review

### Session 1 — 2026-09-19

Four hostile reviewers (Security Adversary, Failure Mode Analyst, Assumption
Destroyer, Scope & Complexity Critic) reviewed the plan against the installed
`@assistant-ui/react@0.15.20` / `@assistant-ui/core@0.3.19` typings and the live
`src/` tree. Full tier: each carried a verification role (Fact Checker, Flow
Tracer, Scope Auditor, Contract Verifier). Every finding passed the evidence
filter with a `file:line` citation.

**Findings:** 15 presented (5 Critical, 10 High) plus 13 additional
medium/low findings, all adjudicated. **Accepted:** all. **Rejected:** none.

| # | Finding | Severity | Disposition | Applied to |
|---|---------|----------|-------------|------------|
| 1 | Sandbox `enabled` cannot gate `run_js`/`run_python`; provider captures runners and `isAvailable: () => true` | Critical | Accept | Phase 1, 6, `tools/builtin/code.ts` |
| 2 | `setMessages` silently enables runtime message-delete without persistence | Critical | Accept | Phase 1 (`onDelete` + `reducer.deleteMessage`) |
| 3 | `engine.editMessage` is not destructive but is labeled destructive | Critical | Accept | Phase 1 (truncate after edit + test) |
| 4 | Required `Settings.sandbox` and `ThreadSummary.title` break unlisted consumers | Critical | Accept | Phase 2, 6 (test files enumerated) |
| 5 | `ProvidersPanel` has no home in Phases 1-3; Phase 2 links to a nonexistent tab | Critical | Accept | Phase 1 (rail) + Phase 4 (tab) |
| 6 | Abort-callback registration cannot be released; `disposeThread` does not unregister | High | Accept | Phase 1 (`ChatEngine.dispose()`) |
| 7 | Global `status` with per-thread engines corrupts `isRunning` | High | Accept | Phase 1 (active-run count) |
| 8 | Rename/label races engine persist and can resurrect a deleted thread | High | Accept | Phase 2 (single owner, queued patch) |
| 9 | Runner ownership duplicated; rebuild never reaches the provider; Pyodide worker orphaned | High | Accept | Phase 1, 6 (one owner + `dispose()`) |
| 10 | Workspace has two owners; `clear()` ambiguous vs `clearWorkspaceHandle` | High | Accept | Phase 1, 3 (single owner) |
| 11 | Workspace-skill enablement never re-applied on reload | High | Accept | Phase 5 |
| 12 | `extractText` is called but undefined | High | Accept | Phase 1 (`convert.ts`) |
| 13 | Session lifetime undefined; `ToolRegistry.hydrate()` non-idempotent | High | Accept | Phase 1 (lifetime + skip-existing hydrate) |
| 14 | Scratchpad "file-less" contradicts the shared runner pair | High | Accept | Phase 6 (two runner sets) |
| 15 | Tool save before collision check poisons `hydrate()` | High | Accept | Phase 5 (pre-check + rollback) |

Additional accepted: imported `SKILL.md` untrusted until enabled (Phase 5);
idle-lock editor dropped (Phase 4); auto-titling dropped (Phase 2);
`SkillEnablementPort` gets an async persist and error channel (Phase 5);
`vault -> chat` import replaced by a locally declared structural ref (Phase 5);
`defaultProviderFor` defined once with a `_form` error fallback (Phases 2, 4);
per-row decrypt/parse for `listThreads` (Phase 2); `restore()` queries permission
and can enter `denied` (Phase 3); byte-scan asserts on ciphertext (Phase 2);
`plans/README.md` assigned to Phase 6; Phase 1 orders the bridge and its browser
gate before shell polish; the "appears only in tests" wording is corrected; the
workspace handle "cleared on lock" claim is corrected.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, `phase-01-shell-and-runtime-bridge.md`,
  `phase-02-conversations-and-workspace-grouping.md`,
  `phase-03-workspace-browser-and-file-editor.md`,
  `phase-04-chat-config-panel.md`, `phase-05-skills-and-tools-panels.md`,
  `phase-06-sandbox-panel.md`.
- Decision deltas checked: destructive edit owned by the engine; `onDelete`
  provided; active-run count replaces global status; `ChatEngine.dispose()`;
  idempotent `ToolRegistry.hydrate()`; runner source with
  `getRunners()`/`isEnabled()`; one `SandboxManager` owner with two runner pairs
  and `dispose()`; `workspace-state` as the single workspace owner; its `clear()`
  never deletes the persisted `db.fs` handle; `ThreadSummary` shape change with its
  consumer list; store-first queue-internal rename/label; manual titles only;
  `defaultProviderFor` defined once; per-row `listThreads` tolerance; ciphertext
  byte scan; settings `skills` with a local structural ref and no `vault -> chat`
  import; imported skills untrusted; idle-lock editor dropped; `plans/README.md`
  assigned to Phase 6.
- Reconciled stale references: removed the auto-title and idle-lock-editor
  requirements, the "leave `onDelete` unset" instruction, the Phase 1
  `getRunners/setRunners` slot, the "existing bridge behaviour" claim for a single
  runner pair, the duplicate `defaultProviderFor`, the `runners()` accessor name,
  and the "decrypted blob bytes" wording. Phase 1's requirement, steps, files,
  risk table, and acceptance now match Phases 2, 4, 5, and 6.
- Unresolved contradictions: 0. Two claims stay intentionally marked UNVERIFIED
  with pre-decided fallbacks: the assistant-ui content-part type used by
  `toUiParts` (Phase 1) and `INTERNAL.MessageRepository`'s constructor shape
  (research open question 4, only needed if phantom branches still misrender).

## Validation Log

### Validation Session 1 — 2026-09-19

Five decisions confirmed with the user. The Red Team Review already carries
verification evidence, so the separate verification pass was skipped per the
validate workflow guard; the open `[UNVERIFIED]` tags were reviewed and both keep
pre-decided fallbacks.

| # | Question | Decision |
|---|----------|----------|
| 1 | Narrow-viewport behavior | **Drawers + overlay panel.** Left list is an overlay drawer, the rail collapses to an icon strip whose panel opens as an overlay; one column usable at a time. |
| 2 | File editor depth | **Add Monaco.** Self-hosted `monaco-editor`, house mono palette, existing 2 MB cap; no CDN because of `script-src 'self'`. Supersedes the plain-textarea decision. |
| 3 | Scratchpad workspace access | **Per-session toggle.** File-less by default, workspace bridge opt-in for the session only; not persisted. |
| 4 | Thread titles | **Manual rename only.** No auto-titling, no model-generated titles. |
| 5 | Skills/tools bulk import/export | **Single-record only.** No bulk JSON export/import. |

Propagation: Key Decisions 9 and 17-19 updated; the Non-goals mobile wording now
points at decision 17; the Risk Summary gained Monaco CSP/worker, Monaco bundle,
overlay focus, and scratchpad-toggle-reset rows. Phase 3 swaps the textarea for
Monaco (dependency, steps, risks, browser gate). Phase 1's shell implements the
drawer/overlay collapse. Phase 6 adds the console access toggle over the existing
two runner pairs. Phase 5 stays single-record.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all six phase files after propagation.
- Decision deltas checked: textarea -> Monaco; undefined responsive collapse ->
  drawers/overlay; file-less-only scratchpad -> per-session toggle;
  auto-titling stays dropped; bulk I/O stays out.
- Reconciled stale references: Phase 3 no longer mentions "no editor dependency"
  or "plain textarea"; Phase 6 no longer claims the console is unconditionally
  file-less; Phase 1 states the drawer/overlay collapse; `package.json` gains
  `monaco-editor` in Phase 3's file list.
- Unresolved contradictions: 0.
