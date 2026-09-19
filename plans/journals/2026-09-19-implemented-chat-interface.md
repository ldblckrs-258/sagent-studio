# Implemented: Chat Interface

Plan: `plans/260919-1437-chat-interface/plan.md`

This file is the manual/browser validation artifact. Every entry records the
date, the build hash, the browser and version, the command used to produce the
build (normally `pnpm build && pnpm preview`), and the observed result. A
"manual check" without this record does not satisfy a phase gate.

> Status: browser gates are PENDING. The implementation session ran in node-only
> mode (`pnpm test`, `pnpm lint`, `pnpm build`). No browser or provider key was
> available, so every browser-only check below is recorded as `PENDING` and must
> be completed under `pnpm build && pnpm preview` before a phase is considered
> fully closed.

## Implementation Summary (2026-09-19)

All six phases are implemented; node gates are green.

- Commands: `pnpm lint` clean, `pnpm test` green (assert; no count encoded per
  plan), `pnpm build` clean (`tsc -b` + Vite, worker chunks emitted).
- New modules: `src/chat/convert.ts`, `src/chat/use-chat-runtime.ts`,
  `src/chat/threads.ts`, `src/chat/config.ts`, `src/session/{session,
  session-provider,session-context,workspace-state}.ts(x)`,
  `src/workspace/tree.ts`, `src/sandbox/manager.ts`,
  `src/skills/enablement.ts`, `src/ui/shell.tsx`,
  `src/ui/{monaco-editor,chat-error-banner}.tsx`, and
  `src/ui/panels/{conversations,workspace,file-editor,chat-config,skills,tools,
  sandbox}.tsx`.
- Additive contracts: `ChatEngine.dispose()`, per-thread run accounting
  (`activeRuns` + `runningThreads`) and idempotent `ToolRegistry.hydrate()`,
  `createCodeToolProvider` over a live runner source, `ChatThread.workspaceName`,
  `ThreadSummary.title|workspaceName`, `Settings.skills` (optional) and
  `Settings.sandbox` (required, defaulted).
- Deviations verified against live code: the engine edit path was already
  destructive (`reducer.editMessage` truncates); the error banner renders just
  above the composer via an app component mounted in the vendored thread; and
  `workspace-state` was created in Phase 1 since the session needs the single
  workspace owner first.
- Unverified without a browser: every item in the per-phase lists below, plus
  the assistant-ui runtime behaviour (research P12), Monaco's worker under the
  build CSP, and the sandbox worker paths. No browser-only behaviour is claimed
  as automated.

## Review Disposition (2026-09-19)

Two code reviews ran (Phase 1, then Phases 2-6). Findings were fixed:

- **Tool same-name edit data loss (Critical).** The tools panel now removes the
  old registry entry before re-registering on a same-name edit, and the rollback
  re-registers only when absent, so it cannot throw a second time.
- **Tool remove ordering.** The store delete runs before the registry delete.
- **Config save failure.** `saveThread` is wrapped; a failed save renders a
  `_form` error instead of claiming "Saved".
- **Workspace-skill edit/remove.** Workspace skills are files with no write
  path; the panel marks them read-only rather than writing a stale vault copy or
  silently no-op'ing the delete. Acceptance criterion 8 is met for vault skills;
  workspace-skill editing is intentionally out of scope.
- **Untrusted enablement.** Any currently-disabled skill now requires an explicit
  confirmation when enabled, which is durable across reload without a persisted
  flag.
- **Sandbox rebuild mid-run.** `setSettings` now defers a runner rebuild until
  the in-flight run settles, so a timeout edit cannot kill a live run.
- **Locked skill policy.** A locked vault now rejects `load()` instead of being
  read as "no policy" (which would have re-enabled every skill).
- **Picker cancel.** A cancelled folder pick is a no-op, not a "permission
  denied" state.
- **File editor close.** Closing with unsaved changes asks for confirmation.
- **Byte hint.** The editor size hint now counts UTF-8 bytes, not UTF-16 units.
- **Bootstrap / overlays.** Conversation auto-select moved to the shell so it
  runs on narrow viewports; opening the Providers tab closes the left drawer.

Residual, unverified without a browser: switching rail panels while the file
editor is dirty still discards the draft (only the explicit close prompts);
main-thread Monaco under `script-src 'self'` without `unsafe-eval`; all
per-phase browser checks below.

## Phase 1 — Shell and Runtime Bridge

- Date: 2026-09-19
- Build hash: `PENDING`
- Browser/version: `PENDING`
- Command: `pnpm build && pnpm preview`
- Node gates: `pnpm lint` clean, `pnpm test` green, `pnpm build` clean
  (tsc + vite, worker chunks emitted).
- Browser checks:
  - first message streams markdown: `PENDING`
  - composer swaps Send to Cancel while streaming: `PENDING`
  - cancel restores the composer and survives reload: `PENDING`
  - edit truncates and re-streams without a duplicate reply: `PENDING`
  - reload an assistant message re-streams: `PENDING`
  - delete a message and confirm it stays deleted after reload: `PENDING`
  - no branch picker and no attachment button in the DOM: `PENDING`
  - thread-switch isolation and concurrent-stream Cancel correctness: `PENDING`
  - long-thread scroll anchoring: `PENDING`
  - narrow viewport: left list and rail panel open as overlays with focus
    restored on close: `PENDING`

## Phase 2 — Conversations and Workspace Grouping

- Browser checks: `PENDING` (create/switch/rename/delete survive reload; rename
  survives a following message; grouping and "No workspace"; streaming badge).

## Phase 3 — Workspace Browser and File Editor

- Browser checks: `PENDING` (pick, reload, re-grant, denied state, tree expand,
  open, dirty, save, size-cap error, Monaco CSP/worker, editor chunk size delta).

## Phase 4 — Chat Config Panel

- Browser checks: `PENDING` (tabs, invalid-input blocking, saved config reaching
  the next model call).

## Phase 5 — Skills and Tools Panels

- Browser checks: `PENDING` (import valid + invalid skill, toggle persistence,
  tool schema rejection, tool delete).

## Phase 6 — Sandbox Panel

- Browser checks: `PENDING` (disabled state, JS timeout kill, JS run, Python run,
  settings persistence across reload, workspace-access toggle reset).
