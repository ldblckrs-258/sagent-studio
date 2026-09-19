# Brainstorm: assistant-ui Chat Interface

- Date: 2026-09-19
- Status: accepted (user-decided forks)
- Scope: `sagent-studio` (browser-only Vite SPA, on top of the Core Chat Engine)
- Feeds plan: new plan for the chat interface (not yet created)
- Predecessor: `plans/260919-0828-core-chat-engine` (implemented)

## Summary

The core chat engine, skills, tools, workspace, and sandbox runners are implemented
and tested but have no user interface. This ticket builds the chat surface with the
already-vendored assistant-ui element kit: a three-column shell whose left column
lists conversations grouped by workspace, whose center is the thread, and whose
right edge is a vertical tool rail that expands panels for workspace picker,
workspace browser, file viewer/editor, chat configuration, skills, tools, and
sandbox. The engine stays the single owner of streaming and persistence; the UI is
a bridge, not a second execution path.

## Contract

**Outcome.** A working chat workspace UI. Left: conversations grouped by workspace,
with create/switch/rename/delete. Center: streaming markdown, reasoning, tool calls,
composer, user-message edit, assistant rerun. Right: icon rail expanding panels for
workspace picker, workspace browser, file viewer/editor, chat config (thread config
+ providers + vault/model settings), skills management, tool/function management,
and sandbox management (config + status + scratchpad console).

**Constraints**

- Browser-only; matches the existing vault/Dexie/WebCrypto architecture.
- The engine remains the only streaming and persistence path. The UI must not
  duplicate or bypass `src/chat/engine.ts`, `reducer.ts`, or `persistence.ts`.
- Bind through `useExternalStoreRuntime` with an app-owned message array (the
  installed `@assistant-ui/react@0.15.20` has no `useChatRuntime`).
- Encrypted persistence only; never render provider API keys or vault material.
- House design system is authoritative: `src/index.css` `@theme` tokens and
  `src/ui/primitives.tsx`. No `docs/design-guidelines.md` exists.
- Text files only, current 2 MB `WorkspaceFs` cap.
- `pnpm lint`, `pnpm test`, and `pnpm build` stay green. Vitest runs in `node`
  with `fake-indexeddb`; keep new UI logic testable outside the browser.
- Vault lock must abort runs and clear chat UI (`src/chat/store.ts:71` already does
  the store half).

**Non-goals.** Attachments, vision, voice/dictation, audio messages; RAG/TypeSafe
(Plan 2); MCP client; provider/vault settings redesign beyond moving them into the
shell; new crypto or envelope format changes; binary file editing; cross-session
branch history; Firefox/Safari folder parity; mobile-app parity beyond a usable
responsive collapse.

**Acceptance criteria**

1. Left column groups conversations by workspace (plus a "No workspace" group),
   and create/switch/rename/delete survive reload.
2. Center renders streamed markdown, reasoning, and tool calls through the
   vendored elements; composer send/cancel is bound to engine status.
3. Editing a user message and rerunning an assistant message go through engine
   semantics; streaming, cancel, and error states are visible and correct.
4. The right rail expands/collapses panels via icon buttons, keyboard accessible,
   with per-session persisted open/active state.
5. Workspace picker picks a folder, re-grants permission after reload, and restores
   the handle; a denied re-grant surfaces an actionable state.
6. Workspace browser lists the tree; the viewer/editor opens a file, tracks dirty
   state, and saves through `WorkspaceFs.writeFile`.
7. Chat config edits every `ThreadConfig` field, including provider/model,
   params, `maxSteps`, and per-thread enabled skills; invalid input is blocked with
   field errors and never reaches the engine.
8. Skills panel lists vault and workspace skills, toggles enablement, imports a
   `SKILL.md`, edits, and removes.
9. Tools panel lists builtin and user tools with availability, persists
   enable/disable, and creates/edits/deletes `http` and `sandbox-js` tools with
   schema validation.
10. Sandbox panel shows runner availability, persists default timeouts and
    enablement, and offers a scratchpad console that runs JS/Python and shows
    stdout/result/errors.
11. All gates pass; vault lock aborts an in-flight run and clears the UI.

## Verified evidence

**Engine and store (bind target).**

- `src/chat/engine.ts:45` `ChatEngine`: `sendTurn(threadId, text)`,
  `editMessage(threadId, messageId, parts)`, `rerun(threadId, messageId)`,
  `undo(threadId)`, `cancel(threadId)`. `editMessage`/`rerun` are destructive:
  they truncate at the target and re-stream (`src/chat/engine.ts:163`, `:178`).
- `src/chat/store.ts:7` `useChatStore`: `threads`, `activeThreadId`,
  `status: 'idle' | 'streaming'`, `error`; `registerAbortAll`; vault-lock
  subscribe clears the store.
- `src/chat/persistence.ts:10` `ThreadSummary = { id, updatedAt }` only; no title,
  no workspace. `saveThread`/`createThread`/`loadThread`/`listThreads`/`deleteThread`
  are encrypted and queue-serialized.
- `src/chat/types.ts:16` `ThreadConfig` = `providerId`, `modelId?`,
  `systemInstruction`, `params{temperature, topP, topK, maxOutputTokens}`,
  `maxSteps >= 4`, `providerOptions?`, `enabledSkills[]`;
  `validateThreadConfig` throws `ChatConfigError`.
- `src/chat/transport.ts:10` `createChatTransport` exists but is not needed if
  `useExternalStoreRuntime` drives `buildRunStream` indirectly through the engine.

**assistant-ui 0.15.20 (verified in installed typings).**

- Bridge is `useExternalStoreRuntime` + `ExternalStoreAdapter`:
  `onNew`, `onEdit`, `onReload(parentId, config)`, `onCancel`, `onDelete`,
  `setMessages`, `isRunning`, `isLoading`, `isDisabled`, `convertMessage`,
  `unstable_messageRepositoryInstance`, and
  `adapters.threadList` (`ExternalStoreThreadData` with `custom?: Record<string, unknown>`,
  `onSwitchToThread`, `onRename`, `onDelete`, `onArchive`). The thread-list adapter
  is marked deprecated/under active development.
- `useRemoteThreadListRuntime` + `RemoteThreadListAdapter` also exist
  (`list`/`rename`/`delete`/`archive`/`initialize`/`fetch`/`generateTitle`), with
  `RemoteThreadMetadata.custom`.
- `ThreadMessageLike` supports `role`, `content` parts (`text`, `reasoning`,
  `tool-call`, `data-*`, `file`, `image`), `status`, `metadata.custom`. No
  message-level `parentId`; branching lives in the runtime's repository.
- Elements already vendored under `src/components/assistant-ui/elements/`:
  `thread.aui.tsx` (includes `EditComposer`, reload, `BranchPicker`, action bar),
  `thread-list.aui.tsx` (groups by date, not workspace), `markdown-text.tsx`
  (`@assistant-ui/react-markdown` + `remark-gfm`, `defer` streaming mode),
  `tool-fallback`, `tool-group`, `reasoning`, `attachment`, `file`, `image`,
  `follow-up-suggestions`.
- `src/index.css:55` already maps shadcn semantic tokens onto the house palette;
  `components.json` aliases `@/`.

**Supporting subsystems (management panels).**

- Skills: `src/skills/registry.ts:17` `SkillRegistry`
  (`list`/`get`/`setEnabled`/`resolve`/`importSkill`/`updateSkill`/`removeSkill`/
  `loadWorkspaceSkills`/`hydrate`); `src/skills/store.ts` `skillStore`
  (`save`/`load`/`list`/`remove`); `src/skills/parser.ts:29` `parseSkillMarkdown`;
  `src/skills/workspace-source.ts:8` `WORKSPACE_SKILLS_ROOT = '.agents/skills'`.
  Enablement is **in-memory only**; `hydrate` re-enables all vault skills.
- Tools: `src/tools/registry.ts:30` `ToolRegistry`
  (`hydrate`/`registerUserTool`/`setEnabled`/`list`/`availableNames`/`buildToolSet`);
  `src/tools/store.ts` `toolStore`. **`setEnabled` does not persist** — the UI must
  also call `toolStore.save`. Builtin providers: `src/tools/builtin/workspace.ts`,
  `src/tools/builtin/code.ts`. Definition kinds: `http`, `sandbox-js`.
- Workspace: `src/workspace/handle.ts` `pickWorkspace`/`restoreWorkspace`/
  `clearWorkspaceHandle`/`isPickerAvailable`, single record at `db.fs` id
  `'workspace'`. `src/workspace/fs.ts:73` `WorkspaceFs` =
  `ensurePermission`/`list`/`readFile`/`writeFile`/`makeDir`/`remove`/`stat`;
  `DEFAULT_SIZE_CAP = 2 MB`; path-safe; permission failures map to
  `WorkspacePermissionError`.
- Sandbox: `src/sandbox/types.ts:12` `CodeRunner.run(source, {timeoutMs})` returns
  `{stdout, stderr, result, error?}`. `JsRunner` default 10 s, `PyRunner` default
  30 s, `defaultJsWorkerFactory`/`defaultPyWorkerFactory`. **No persisted config,
  no status or last-run API, no factory that assembles a runner from settings.**
- Providers: `src/vault/settings.ts:30` `Settings.providers[]`, each with its own
  `models`/`defaultModel`; **no global default provider**. `validateProvider` and
  `resolveProvider` in `src/ai/providers.ts`; `ModelManager` in
  `src/ai/model-manager.tsx`.
- Current app entry: `src/App.tsx` renders unlock/error boundaries and a plain page
  with `StorageWarning`, `DataEgressNotice`, `ProvidersPanel`.

## Options considered

### 1. Workspace model — decision: single workspace

| Option | Trade-off | Fails first when |
| --- | --- | --- |
| Multi-workspace registry + `thread.workspaceId` | Literal "grouped by workspace"; needs a registry, per-thread handle resolution, envelope v2 | Chosen option? No — user chose single |
| Multi-workspace, binding fixed at creation | Same cost, less UI | same |
| **Single workspace (chosen)** | No registry; keeps current `db.fs` handle | Threads created under a different folder lose their grouping meaning unless the label is snapshotted |

Chosen interpretation: keep one global handle, and snapshot the folder **name** onto
the thread when a run or creation happens. Group the list by that snapshot, with a
"No workspace" group for threads created before a folder was picked. Picking a new
folder changes the workspace for future turns; older threads keep their old label.
This honors the layout requirement with one optional additive thread field instead
of a new table.

### 2. Edit / rerun — decision: destructive, hide branch picker

`onEdit -> engine.editMessage`, `onReload(parentId) -> engine.rerun(threadId, parentId)`.
The vendored thread already renders an edit composer. The `BranchPicker` is not
meaningful against truncating history, so it is hidden or removed, and assistant-ui's
internal branch repository is not given a persistence story.

Alternative rejected: persist a `parentId` tree and keep old branches swappable
across reloads. Larger scope (envelope v2 + reducer/persistence rework) with no
stated requirement.

### 3. Thread-list integration — recommendation: app-owned list

The vendored `thread-list.aui.tsx` groups by date and depends on the runtime thread
list. The requirement needs workspace grouping, titles, and rename/delete over the
encrypted store.

| Option | Trade-off | Fails first when |
| --- | --- | --- |
| `useExternalStoreRuntime` + `adapters.threadList` | Native `ThreadListPrimitive` support, `custom` metadata available | The adapter is deprecated and in flux; grouping is date-shaped, so the list is forked anyway |
| `useRemoteThreadListRuntime` + `RemoteThreadListAdapter` | Clean list/rename/delete/fetch/archive mapping to the vault store | Requires `generateTitle` streaming and per-thread adapters the app does not need |
| **Custom left list over `listThreads()` + `useChatStore` (recommended)** | Full control of grouping, titles, dirty/streaming badges; no deprecated APIs; reuses existing store | Loses `ThreadListPrimitive` conveniences; rename/delete are hand-written (small) |

Recommend the custom list because the grouping requirement already breaks the
vendored component, and the engine/store already expose everything needed.

### 4. Sandbox panel — decision: config + status + scratchpad

Add a small settings slice for sandbox enablement and default timeouts (additive to
`Settings`; `deepMerge` tolerates it without a version bump), a factory that builds
`JsRunner`/`PyRunner` from those settings, runner availability derived from
`Worker` support, and a scratchpad console that calls `CodeRunner.run` directly.
Scope includes a last-run result/error surface, which the runner already returns.

### 5. Settings placement — decision: right-rail tabbed config

`App.tsx` becomes the shell. The right rail's config panel is tabbed: **Thread**
(per-thread `ThreadConfig`), **Providers** (existing `ProvidersPanel` +
`ModelManager`), **Vault** (`StorageWarning`, `DataEgressNotice`, idle-lock). One
place to configure everything; no second competing layout.

### 6. File viewer/editor — recommendation: plain textarea

No editor dependency is installed. Recommend a mono-font textarea with dirty
tracking, explicit save/cancel, and size/permission error handling. CodeMirror or
Monaco is a later, separate decision; adding one now is scope the requirement does
not demand.

## Recommendation

Build one phased plan that lands the shell before the panels, so the center column
is usable early and each panel is independent:

1. Shell + runtime bridge: 3-column layout, `AssistantRuntimeProvider` +
   `useExternalStoreRuntime`, center thread, status/error wiring, vault-lock clear.
2. Conversations: thread CRUD over the encrypted store, workspace label snapshot,
   grouped custom left list, active-thread load.
3. Workspace: picker (with re-grant), browser tree, viewer/editor.
4. Chat config: tabbed rail panel (thread config + providers + vault).
5. Skills and tools management panels, including persisted enablement.
6. Sandbox panel: config + status + scratchpad.

Integration facts the plan must carry: `useExternalStoreRuntime` adapter shape;
`convertMessage` mapping from `UIMessage` parts to `ThreadMessageLike` (text,
reasoning, `tool-<name>`); `onEdit` payload to `UIMessage['parts']`; `isRunning`
from `useChatStore.status`; per-thread engine instances over one `ThreadStore`;
`ToolRegistry.setEnabled` must be paired with `toolStore.save`; vault lock already
clears the chat store.

## Unresolved questions

1. Editor depth: plain textarea now, or add CodeMirror/Monaco in this plan?
2. Scratchpad workspace access: should the console also read/write the picked
   workspace, or run code with no filesystem bridge?
3. Thread titles: auto-generate from the first user message, or manual rename only?
4. Responsive behavior: how should the three columns collapse on narrow viewports
   (drawers vs stacked tabs)?
5. Per-thread provider default: default a new thread to the first provider, or add an
   explicit global default provider to `Settings`?
6. Do skills/tools panels need bulk import/export (JSON) or only single-record
   editing?
