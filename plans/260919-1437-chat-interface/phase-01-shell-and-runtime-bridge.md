---
phase: 1
title: "Shell and Runtime Bridge"
status: implemented (browser gate pending)
priority: P1
effort: "12h"
dependencies: []
---

# Phase 1: Shell and Runtime Bridge

## Goal

Land the app-level session composition and a full-bleed three-column shell whose
center column is the vendored assistant-ui thread bridged to the engine through
`useExternalStoreRuntime`, so the chat surface is usable before any panel exists.

## Context

- Nothing in application code instantiates the engine or the registries today;
  `createEngine`, `SkillRegistry`, `ToolRegistry`, `JsRunner`, `PyRunner`,
  `useExternalStoreRuntime`, and `AssistantRuntimeProvider` appear only inside
  `node_modules`, not in `src/` (grep). `src/chat/engine.ts:322` is referenced
  only by tests.
- `AssistantRuntimeProvider` takes `runtime` as its only required prop and
  installs an `AuiProvider` internally, so `AuiConfig`/`AuiProvider` are not
  needed (research 01 §1).
- For an external store, `convertMessage`, `messages`, and `onNew` are the
  required adapter fields; `isRunning`, `setMessages`, `onEdit`, `onReload`,
  `onCancel`, and `onDelete` are the optional fields this app needs
  (research 01 §1 table).
- `isRunning` must be set explicitly. Omitting it makes the last assistant
  message settle to `complete` and Cancel never appears, because the runtime's
  fallback status is itself derived from `isRunning` (research 01 §5, P8).
- Supplying `setMessages` alone turns on the runtime's `delete` capability
  (`@assistant-ui/core` `external-store-thread-runtime-core.js:166`:
  `delete: onDelete !== undefined || setMessages !== undefined`), so `onDelete`
  must be provided too, or a runtime delete becomes an unpersisted memory edit.
- `onNew`/`onEdit` receive `AppendMessage`, so the app needs a reverse converter
  from assistant-ui content parts to `UIMessage['parts']` (research 01 §3).
- `onEdit.message.sourceId` is the edited message id; `onReload`'s
  `config.sourceId` is the assistant message to regenerate (research 01 §3).
- `reducer.editMessage` (`src/chat/reducer.ts:11-19`) replaces in place and keeps
  every later message; `engine.editMessage` (`src/chat/engine.ts:163-176`) then
  appends a second assistant reply. The edit path is therefore NOT destructive
  today and must be made so (red-team finding 3). `reducer.truncateAfter`
  (`:27-31`) already exists for this, and `reducer.deleteMessage` (`:21-25`)
  exists for `onDelete`.
- There is no thread-level error field in `ThreadState`; the sanctioned surfaces
  are a message-status projection or an app banner (research 01 §7).
- `createCodeToolProvider` captures the runner object at construction and
  declares `isAvailable: () => true` (`src/tools/builtin/code.ts:29-52`), and
  `ToolRegistry.registerProvider` throws on re-registration with no removal path
  (`src/tools/registry.ts:43-51`). A settings-driven enable/rebuild therefore
  needs the provider to read a live source, not a captured object (findings 1, 9).
- `DefaultEngine` calls `registerAbortAll` and discards the returned unsubscribe
  (`src/chat/engine.ts:148-150`); `ChatEngine` has no dispose, so every thread
  engine leaks a permanent callback in the module-level `aborters` Set
  (`src/chat/store.ts:58-65`; finding 6).
- Each engine clears the single global `status` when its own controller map
  empties (`src/chat/engine.ts:264-266`), so two concurrent thread streams corrupt
  `isRunning` (finding 7).
- `ToolRegistry.hydrate` throws on a duplicate name (`src/tools/registry.ts:39-41`,
  `:53-62`), so a second unlock in a module-scoped session fails (finding 13).
- The current `UnlockedApp` is the only mount of `ProvidersPanel`
  (`src/App.tsx:42-46`) and caps content at `max-w-5xl`, which would starve a
  right rail; the vendored thread already provides its own 44rem reading width
  (`thread.aui.tsx:194`). `ProvidersPanel` must stay reachable in this phase
  (finding 5).
- `ComposerAddAttachment` still renders and swallows its own failure without an
  attachments adapter, so it must be deleted from the JSX; `BranchPicker` becomes
  visible after destructive rerun (research 01 §6, P3).
- Design tokens live in `src/index.css`; `panel-in` is the sanctioned panel motion
  (`index.css:196-205`); house controls use `min-h-11` (`src/ui/primitives.tsx:30`).
- `src/chat/store.ts:71-76` already aborts runs and clears threads on vault lock;
  this phase only reacts to it.

## Requirements

Functional:

- One `SkillRegistry`, one `ToolRegistry` (registering `workspaceToolProvider`
  and a code provider that reads a live runner source), one mutable runner slot,
  and a per-thread `ChatEngine` map with a `ThreadStore` shim over
  `src/chat/persistence.ts`.
- Session lifetime is explicit: one session instance per vault unlock, created in
  `SessionProvider` and disposed with the provider. Nothing is module-global.
- `src/chat/convert.ts` provides pure `toThreadMessageLike`, `toUiParts`, and
  `extractText` following research 01 §2 and §3 exactly: text, reasoning,
  `tool-<name>` and `dynamic-tool`, data, file, sources; drop `step-start`;
  synthesize `argsText`; emit an explicit `status` only for a terminal error; never
  emit a status on a non-assistant message. `extractText(parts)` joins non-empty
  `text` parts with `\n`, ignores reasoning and tool parts, and throws no error.
- `src/chat/use-chat-runtime.ts` wires `messages` from `useChatStore`,
  `isRunning` from the active-run count, `isLoading`, `isDisabled`,
  `isSendDisabled`, `setMessages`, and `onNew`/`onEdit`/`onReload`/`onCancel`/
  `onDelete`. `unstable_enableToolInvocations` is not passed.
- `src/chat/engine.ts` gains a destructive edit (truncate downstream messages
  after the edited id before the run), a `dispose()` that unregisters the abort
  callback, and an explicit active-run signal so `status` is not cleared while
  another thread streams.
- `src/tools/builtin/code.ts` takes a runner source
  `{ getRunners(): CodeToolRunners; isEnabled(): boolean }` and reads it inside
  `isAvailable` and `create`, so a later enable toggle or runner swap takes effect
  without re-registration.
- `ToolRegistry.hydrate()` skips already-registered names instead of throwing, so
  a re-unlock is safe.
- `src/ui/shell.tsx` renders a full-bleed three-column layout with a left
  conversations slot, the center `Thread` under `AssistantRuntimeProvider`, and a
  right vertical icon rail whose buttons are keyboard accessible and whose
  open/active-panel state persists per session. Below the shell breakpoint the
  left column becomes an overlay drawer and the rail panel opens as an overlay, so
  one column is usable at a time (user decision, Validation Session 1; reuses the
  `dialog`/`collapsible` primitives and restores focus on close).
- The shell keeps `ProvidersPanel`, `StorageWarning`, and `DataEgressNotice`
  reachable in this phase: `ProvidersPanel` mounts in the rail (Phase 4 moves it
  into the Providers tab), and the notices stay in the center column until Phase 4
  relocates them.
- `UnlockedApp` renders `SessionProvider` + `Shell` and keeps `useIdleLock`,
  `Shortcuts`, and the `Lock` button.
- `ComposerAddAttachment`, `ComposerAttachments`, and `BranchPicker` are removed
  from `thread.aui.tsx` along with their now-unused imports.
- An error banner above the composer renders `useChatStore.error`; a vault lock or
  a deleted active thread returns the center column to an empty state.

Non-functional:

- New app files under `src/session/`, `src/chat/`, and `src/ui/` use house style:
  relative imports, single quotes, no semicolons, 2-space indent.
- `src/chat/convert.ts` imports no React and no store; it is a pure module.
- `src/chat/engine.ts`, `src/chat/store.ts`, `src/tools/registry.ts`, and
  `src/tools/builtin/code.ts` changes stay backward compatible with their existing
  tests, which are updated where the behavior intentionally changes.
- No new design token unless a token is genuinely missing; reuse `panel-in`,
  `min-h-11`, and the existing palette.
- The workspace is owned in one place: the session reads `workspace-state`
  (Phase 3), and this phase only wires a `WorkspaceFs | null` getter over it.

## Architecture

```
src/session/session.ts          app composition: registries, runner slot, thread
                                store shim, per-thread engine map, workspace getter
src/session/session-provider.tsx React context: mounts per unlock, hydrates,
                                restores workspace, disposes on lock
src/chat/convert.ts             UIMessage <-> assistant-ui parts (pure)
src/chat/use-chat-runtime.ts    useExternalStoreRuntime adapter + callbacks
src/ui/shell.tsx                three-column layout + icon rail + panel host
src/App.tsx                     UnlockedApp -> SessionProvider + Shell
src/chat/engine.ts              destructive edit + dispose + run accounting
src/chat/store.ts               active-run signal for isRunning
src/tools/registry.ts           idempotent hydrate
src/tools/builtin/code.ts       runner-source-based availability
src/components/assistant-ui/elements/thread.aui.tsx  remove attachment + branch UI
```

Data flow:

```
useChatStore(messages, activeRuns, error, activeThreadId)
        |
        v
use-chat-runtime  --convertMessage-->  ThreadMessageLike[]  -->  assistant-ui runtime
        |                                                            |
        |  onNew / onEdit / onReload / onCancel / onDelete            v
        +---------------------> session engine map -------------> Thread / Composer
                                  (createEngine per thread)
        +<---- setMessages (runtime rewrite, in-memory only) --------+
```

`session.ts` owns:

```ts
interface AppSession {
  skillRegistry: SkillRegistry
  toolRegistry: ToolRegistry
  threadStore: ThreadStore              // shim over src/chat/persistence.ts
  runnerSource: RunnerSource            // { getRunners(), isEnabled() }
  engineFor(threadId: string): ChatEngine
  disposeThread(threadId: string): void
  getWorkspace(): WorkspaceFs | null    // delegates to workspace-state
  setWorkspace(fs: WorkspaceFs | null): void  // writes through to workspace-state
}
```

`engineFor` memoizes one `createEngine` per thread id. `EngineDeps.workspace` and
`EngineDeps.codeRunner` are exposed as getters over the session slots so each run
reads the current instance rather than a captured one. `disposeThread` calls the
engine's `dispose()` — which unregisters the abort callback — and then drops it
from the map. Dropping from the map alone is not enough (finding 6).

The `ThreadStore` shim is a direct mapping:

```ts
const threadStore: ThreadStore = { loadThread, saveThread, listThreads, deleteThread }
```

Run accounting: `src/chat/store.ts` gains `activeRuns: number` and
`beginRun()`/`endRun()`; each engine calls them around a run and sets
`status: 'streaming'` on begin and `'idle'` when the count reaches zero. A single
engine must not set `idle` on its own (finding 7).

## Files to Create / Modify

- Create: `src/session/session.ts`
- Create: `src/session/session-provider.tsx`
- Create: `src/chat/convert.ts`
- Create: `src/chat/convert.test.ts`
- Create: `src/chat/use-chat-runtime.ts`
- Create: `src/ui/shell.tsx`
- Modify: `src/chat/engine.ts` (destructive edit, `dispose()`, run accounting)
- Modify: `src/chat/engine.test.ts` (destructive edit + dispose regression tests)
- Modify: `src/chat/store.ts` (active-run signal)
- Modify: `src/chat/store.test.ts` (run accounting)
- Modify: `src/tools/registry.ts` (idempotent `hydrate`)
- Modify: `src/tools/registry.test.ts` (double hydrate)
- Modify: `src/tools/builtin/code.ts` (runner source)
- Modify: `src/tools/builtin/code.test.ts` (enable/disable + runner swap)
- Modify: `src/App.tsx` (render `SessionProvider` + `Shell`)
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx` (remove
  `ComposerAddAttachment`, `ComposerAttachments`, `BranchPicker`)
- Modify: `src/index.css` only if a genuinely new token is required
- Create: `plans/journals/2026-09-19-implemented-chat-interface.md` (seed the
  manual-validation artifact)

## Implementation Steps

Order matters: the bridge and its browser gate come before shell polish, so a
bridge failure stops the phase without stranding shell work (finding 26).

1. Add `src/chat/store.ts` run accounting: `activeRuns: number`, `beginRun()`,
   `endRun()`, and make `setStatus` derived (`streaming` iff `activeRuns > 0`) so
   one engine cannot clear another's run. Add `store.test.ts` coverage.
2. Modify `src/chat/engine.ts`:
   - `editMessage` truncates after the edited id before `startRun` by using
     `truncateAfter` when the target is a user message; add a regression test
     asserting the downstream assistant message is gone and no duplicate reply
     results (finding 3).
   - Add `dispose(): void` to `ChatEngine`; retain the `registerAbortAll`
     unsubscribe in the constructor and call it on dispose (finding 6).
   - Replace direct `setStatus('idle')` with `endRun()`.
3. Modify `src/tools/registry.ts`: `hydrate()` skips a name that is already
   registered (provider or user tool) instead of throwing (finding 13). Extend
   `registry.test.ts` with a double-hydrate assertion.
4. Modify `src/tools/builtin/code.ts` to accept
   `{ getRunners(): CodeToolRunners; isEnabled(): boolean }`; `isAvailable` returns
   `source.isEnabled()`, and `create` reads `source.getRunners()` at call time.
   Keep `NAMES` and the tool schemas unchanged. Extend `code.test.ts` for
   enabled/disabled availability and for a swapped runner being used.
5. Add `src/session/session.ts`. Construct `SkillRegistry` and `ToolRegistry`,
   register `workspaceToolProvider` and the code provider over the runner source,
   and define the `ThreadStore` shim over
   `loadThread`/`saveThread`/`listThreads`/`deleteThread`
   (`src/chat/persistence.ts:84-100`). The default runner source builds
   `JsRunner`/`PyRunner` from `DEFAULT_JS_TIMEOUT_MS` / `DEFAULT_PY_TIMEOUT_MS`
   (`src/sandbox/js-runner.ts:9`, `src/sandbox/py-runner.ts:9`) and is `enabled:
   true` until Phase 6 binds it to settings.
6. Implement `engineFor(threadId)` with `createEngine({ getSettings, skillRegistry,
   toolRegistry, threadStore, workspace, codeRunner })` where `getSettings` reads
   `useVaultStore.getState().settings` and `workspace`/`codeRunner` are getters
   over the session slots. Memoize per thread id; `disposeThread` calls
   `engine.dispose()` then deletes the map entry.
7. Add `src/session/session-provider.tsx`: a React context exposing the session,
   created per mount (per unlock) and disposed on unmount. It runs
   `skillRegistry.hydrate()`, `toolRegistry.hydrate()`, and
   `restoreWorkspace()` (`src/workspace/handle.ts:20`) in an effect after unlock,
   and clears the workspace getter and disposes thread engines on cleanup. Keep
   hydrate failures non-fatal and visible (set an error string) rather than
   crashing the shell.
8. Add `src/chat/convert.ts` with `toThreadMessageLike(message: UIMessage, index:
   number): ThreadMessageLike`, `toUiParts(content): UIMessage['parts']`, and
   `extractText(content): string`, implementing research 01 §2 and §3
   part-by-part, including dropping `step-start`, dropping blank
   text/reasoning, synthesizing `argsText: JSON.stringify(input ?? {})`, and
   mapping `output-error`/`output-denied` to `isError: true`. Do not emit a
   message `status` unless it is a terminal error, and never on a non-assistant
   message. Use a structural content-part type for `toUiParts` input rather than
   guessing an exported part type name `[UNVERIFIED]`; confirm and narrow at
   implementation time.
9. Write `src/chat/convert.test.ts` covering: text only; reasoning;
   `tool-<name>` with `output-available`; `dynamic-tool`; `input-streaming` with
   partial input; `output-error`; data part; file part field renaming
   (`url -> data`, `mediaType -> mimeType`); `step-start` dropped; round-trip
   `toUiParts(toThreadMessageLike(...))` for a text message; `extractText`
   joining multiple text parts and ignoring reasoning; status omitted for a
   normal assistant message and for every non-assistant message.
10. Add `src/chat/use-chat-runtime.ts`. Read `messages`, `activeRuns`, `error`,
    and `activeThreadId` from `useChatStore` with primitive selectors
    (research 01 P1). Call `useExternalStoreRuntime<UIMessage>` with
    `convertMessage`, `isRunning: activeRuns > 0`, `isLoading: false`,
    `isDisabled: !settings || activeThreadId === null`, `isSendDisabled:
    providers.length === 0`, `setMessages`, and `onNew`/`onEdit`/`onReload`/
    `onCancel`/`onDelete`. Do not pass `suggestions` or
    `unstable_enableToolInvocations`.
11. Implement the callbacks: `onNew` calls
    `engineFor(activeThreadId).sendTurn(activeThreadId, extractText(message.content))`;
    `onEdit` calls `editMessage(activeThreadId, message.sourceId, toUiParts(message.content))`;
    `onReload` calls `rerun(activeThreadId, config.sourceId)`; `onCancel` calls
    `cancel(activeThreadId)`; `onDelete` deletes through `reducer.deleteMessage`
    and persists via `saveThread` + `useChatStore.setThread` (finding 2). Wrap
    each in try/catch and route an unexpected rejection to
    `useChatStore.setError` so the composer never sees an unhandled rejection
    (`requireThread` can throw before the run, `src/chat/engine.ts:154`, `:169`).
12. Implement `setMessages(next)` to write a new array identity into
    `useChatStore.setThread({ ...thread, messages: [...next] })` without
    persisting, because the engine is the persistence owner for run output. The
    `onDelete` path is the one exception and persists explicitly.
13. Add `src/ui/shell.tsx`: a `h-dvh` full-bleed three-column frame. Left column is
    a `<aside>` slot that Phase 2 fills; center is
    `<AssistantRuntimeProvider runtime={runtime}><Thread /></AssistantRuntimeProvider>`
    with the runtime from `useChatRuntime`; right column is a vertical icon rail of
    keyboard-accessible buttons (each with an `aria-label` and `aria-expanded`)
    plus an expandable panel region. Mount `ProvidersPanel` as the initial rail
    panel so provider configuration stays reachable until Phase 4 (finding 5).
    Hold `{ open: boolean; activePanel: string }` in component state initialised
    from `sessionStorage` and write back on change. Animate panel entry with
    `motion-safe:animate-[panel-in_180ms_var(--ease-out-quint)]` and keep rail
    buttons at `min-h-11`/`size-11`. Below the shell breakpoint, render the left
    column as an overlay drawer toggled from a top-bar button and the rail panel as
    an overlay, restoring focus to the trigger on close. Render `StorageWarning`
    and `DataEgressNotice` above the thread for now.
14. Render `useChatStore.error` as a `role="alert"` banner immediately above the
    composer region, styling with `border-danger-rule`/`bg-danger-soft`. Do not
    project the error into message status.
15. Modify `src/App.tsx`: `UnlockedApp` returns `SessionProvider` wrapping `Shell`,
    keeping `useIdleLock`, `Shortcuts`, and `Lock`. Remove the `max-w-5xl` main
    container; the shell owns layout. Do not leave dead imports.
16. Modify `thread.aui.tsx`: delete the `ComposerAttachments` and
    `ComposerAddAttachment` JSX, delete both `<BranchPicker … />` usages, delete
    the local `BranchPicker` component, and remove the now-unused imports
    (`ComposerAddAttachment`, `ComposerAttachments`, `BranchPickerPrimitive`,
    `ChevronLeftIcon`, `ChevronRightIcon`). Keep `UserMessageAttachments` only if
    the import is still used; otherwise remove it too. Do not remove the
    `AttachmentDropzone` wrapper, dictation, feedback, or suggestions in this
    phase.
17. Seed `plans/journals/2026-09-19-implemented-chat-interface.md` with the
    phase-section template (date, build hash, browser, command, observed result).
18. `pnpm test`, `pnpm lint`, `pnpm build`.
19. Stop-the-line browser gate before finalizing the phase: `pnpm build && pnpm
    preview`, drive with agent-browser, and record: first message streams
    markdown; composer swaps Send to Cancel while streaming; cancel restores the
    composer and survives reload; edit a user message truncates and re-streams
    without a duplicate reply; reload an assistant message re-streams; delete a
    message and confirm it stays deleted after reload; no branch picker; no
    attachment button; switching threads shows no bleed-through; two threads do
    not corrupt the Cancel state; scroll on a long thread; narrow the viewport and
    confirm the left list and rail panel open as overlays with focus restored on
    close.

## Todo

- [ ] `src/chat/store.ts` active-run accounting + test
- [ ] `src/chat/engine.ts` destructive edit, `dispose()`, run accounting + tests
- [ ] `src/tools/registry.ts` idempotent hydrate + test
- [ ] `src/tools/builtin/code.ts` runner source + tests
- [ ] `src/session/session.ts` (registries, runner source, thread-store shim, engine map)
- [ ] `src/session/session-provider.tsx` (per-unlock lifetime, hydrate, restore workspace, dispose)
- [ ] `src/chat/convert.ts` (`toThreadMessageLike`, `toUiParts`, `extractText`) + `convert.test.ts`
- [ ] `src/chat/use-chat-runtime.ts` (explicit `isRunning`, `setMessages`, five callbacks)
- [ ] `src/ui/shell.tsx` (three columns, icon rail, ProvidersPanel, per-session panel state)
- [ ] `src/App.tsx` renders `SessionProvider` + `Shell`
- [ ] `thread.aui.tsx` attachment + branch UI removed with unused imports
- [ ] error banner above the composer
- [ ] journal seeded; browser smoke recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/chat src/tools` passes, including the converter, destructive
  edit, dispose, active-run, idempotent-hydrate, and runner-source tests.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean. `pnpm build` also typechecks the new tests
  through `tsc -b` (`tsconfig.app.json:30`).
- Grep gate: `src/chat/convert.ts` imports neither `react` nor
  `../chat/store`; `src/session/session.ts` imports no React component.
- Browser gate (recorded in
  `plans/journals/2026-09-19-implemented-chat-interface.md` with build hash and
  browser version): streaming markdown, Cancel on an active run, edit truncation,
  reload, delete-then-reload, cancel-then-reload, no branch picker, no attachment
  button, thread-switch isolation, concurrent-stream Cancel correctness, and
  long-thread scroll anchoring.

## Success Criteria

- [ ] Acceptance criteria 2, 3, and 4 are demonstrated by the browser gate.
- [ ] The center column renders a real streamed turn from a configured provider,
      and a provider can be configured from the shell before Phase 4.
- [ ] `isRunning` follows an active-run count and Cancel appears only while a run
      is in flight, including with two threads streaming.
- [ ] Editing a user message truncates downstream messages and routes through the
      engine; reloading an assistant message uses `engine.rerun`.
- [ ] `onDelete` persists; a deleted message does not reappear after reload.
- [ ] No attachment button and no branch picker are reachable in the DOM.
- [ ] Disposing a thread engine unregisters its abort callback; a session unit
      test asserts the registry set does not grow across create/dispose cycles.
- [ ] The shell is full-bleed, keyboard navigable, and preserves panel state
      across a reload within the session.
- [ ] Below the breakpoint the left list and rail panels open as overlays with
      focus restored to the trigger on close.
- [ ] Failure of the runtime bridge stops the phase and is escalated rather than
      papered over with a second execution path.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| `isRunning` omitted or misread | Composer stays on Send while streaming; last assistant message settles to `complete` | Set it explicitly from the active-run count and re-check in the browser gate (research P8). |
| `onEdit` receives already-converted parts and the reverse converter drops content | Edit loses text or sends an empty message | Unit-test `toUiParts` round-trip; keep non-text parts appended after the edited text (research §3). |
| The engine edit path stays non-destructive | Two assistant replies; the new run sees the stale one | Truncate after the edited id before `startRun`; regression test asserts no duplicate (finding 3). |
| `setMessages` enables delete and delete is not persisted | A deleted message reappears after reload | Provide `onDelete`, delete through `reducer.deleteMessage`, persist with `saveThread`; browser gate checks delete-then-reload (finding 2). |
| Repository bleed-through across thread switches | Thread A messages appear in thread B | Add `key={threadId}` to the provider as the first fallback; then a per-thread repository (P4). |
| Concurrent streams across threads corrupt Cancel/`isRunning` | Cancel/Send swaps at the wrong time | Active-run count in `useChatStore`; browser gate streams two threads (finding 7). |
| Abort registrations accumulate per thread | `aborters` grows across create/dispose | `dispose()` unregisters; `disposeThread` calls it (finding 6). |
| `hydrate` throws on the second unlock | Spurious error banner; tools missing | Skip-existing hydrate; double-hydrate test (finding 13). |
| Code provider captures runners | Sandbox enable/timeout changes never reach model tools | Runner-source getters; provider test asserts a swapped runner is used (findings 1, 9). |
| React Compiler rewrites vendored patterns | Render anomalies in the thread only | Keep new components Compiler-safe; exclude the offending vendored file from the compiler pass. |
| `content-visibility` scroll jumping | Long-thread scroll position jumps | Raise `[contain-intrinsic-size]` or drop `content-visibility` in app-owned markup (P5). |
| One owner for the workspace is not respected | Engine sees a different `WorkspaceFs` than the panel | Session delegates to `workspace-state`; no second slot (finding 10). |
| Overlay drawers trap focus or hide the composer | Keyboard navigation loses focus; chat unusable on narrow screens | Reuse the `dialog`/`collapsible` primitives, restore focus on close, and cover it in the shell browser gate. |
| `hydrate` or `restoreWorkspace` throws at mount | Blank shell | Catch per-operation; surface a non-fatal session error string; never block the thread render. |

## Security Considerations

- `SessionProvider` gates on vault unlock; `getSettings` returns `null` when
  locked, and the engine already refuses to run then (`src/chat/engine.ts:98`).
- No secret is rendered: the shell shows only an error banner; error text comes
  from `useChatStore.error`, which the engine redacts (`src/chat/engine.ts:58-68`).
- The live `WorkspaceFs` reference is dropped on lock. The underlying
  `FileSystemDirectoryHandle` is deliberately persisted at `db.fs` id
  `'workspace'` (`src/vault/db.ts:40-44`, `src/workspace/handle.ts:12-24`); that
  persistence is the accepted engine-plan decision and permission re-grant is the
  real gate, not the lock (red-team finding 28). This phase does not claim the
  handle is erased.
- No handle or key is ever passed into a worker from this phase.
- The converter handles `file` parts defensively even though attachments are a
  non-goal, so a stray part cannot crash the thread.

## Next Steps

Phases 2, 3, and 4 all extend `src/ui/shell.tsx`. Phase 2 fills the left slot
first because the center column needs a way to create and switch threads. Phase 4
relocates `ProvidersPanel` from this phase's rail panel into the Providers tab.
