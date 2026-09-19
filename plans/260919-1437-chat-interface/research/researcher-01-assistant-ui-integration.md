---
title: "Wiring @assistant-ui/react 0.15.20 to the UI-agnostic chat engine"
date: 2026-09-19
plan: 260919-1437-chat-interface
role: technical research (researcher-01)
status: final
scope: browser-only Vite 8 / React 19 / TS 6 SPA, engine-owned streaming + encrypted persistence
---

# assistant-ui 0.15.20 ↔ chat engine integration

## Bottom line up front

The bridge is `useExternalStoreRuntime` (`@assistant-ui/react`) over an app-owned
`readonly UIMessage[]`, mounted through `AssistantRuntimeProvider`. Provider-only is
sufficient: `AuiConfig` / `AuiProvider` are **not** required — `AssistantRuntimeProvider`
installs an `AuiProvider` internally and takes `runtime` as its only required prop
(`AUI/legacy-runtime/AssistantRuntimeProvider.d.ts:6-29`).

Three things decide the whole wiring:

1. **`isRunning` must be set explicitly** from `useChatStore.status === 'streaming'`.
   Omitting it does not fall back to a useful heuristic for external stores — the
   runtime's own auto-status is itself computed from `isRunning`
   (`CORE/runtime/utils/auto-status.js:42`), so omitting it makes the last assistant
   message settle to `complete` and the composer's Cancel never appears.
2. **`onNew` / `onEdit` receive `AppendMessage`, not `UIMessage`.** They carry
   already-converted assistant-ui content parts, so the app needs a *reverse* converter
   (`ThreadMessage` content → `UIMessage['parts']`), not a pass-through
   (`CORE/types/message.d.ts:400`, `CORE/runtime/base/default-edit-composer-runtime-core.js:48-56`).
3. **Thread-level errors have no runtime field.** `ErrorPrimitive.Message` reads
   `s.message.status.error` on a message whose status is `incomplete`/`error`
   (`CORE/store/primitive-predicates.js:16-22`). To surface `engine.error` you either
   project it onto a message status (via `convertMessage` or the
   `useExternalMessageConverter` metadata path) or render your own banner outside the
   thread.

Recommended wiring: **adapter `convertMessage`** (single converter, no extra library
paths) plus a **custom left list** (the brainstorm's decision) and, for multi-thread
branch isolation, an `unstable_messageRepositoryInstance` per thread obtained through
`INTERNAL.MessageRepository`.

### Path shorthand

- `AUI/` = `node_modules/@assistant-ui/react/dist/`
- `CORE/` = `node_modules/.pnpm/@assistant-ui+core@0.3.19_@assistant-ui+store@0.3.13_@assistant-ui+tap@0.9.17_@types+re_514925cf0ac5f1b28465ce1a6b814393/node_modules/@assistant-ui/core/dist/`
- `STORE/` = `node_modules/.pnpm/@assistant-ui+store@0.3.13_@assistant-ui+tap@0.9.17_@types+react@19.3.0_react@19.3.0__@types+react@19.3.0_react@19.3.0/node_modules/@assistant-ui/store/dist/`
- `AIMD/` = `node_modules/@assistant-ui/react-markdown/dist/`
- `AI/` = `node_modules/ai/dist/index.d.ts` (ai 7.0.105)
- App files relative to repo root.

---

## 1. Minimal single-thread wiring

### `AssistantRuntimeProvider` prop shape

`AUI/legacy-runtime/AssistantRuntimeProvider.d.ts:6-29`:

```ts
namespace AssistantRuntimeProvider {
  type Props = PropsWithChildren<{
    runtime: AssistantRuntime;   // required
    aui?: AssistantClient;       // optional parent client (nesting only)
    config?: AuiConfig;          // optional extra scopes
  }>;
}
```

Mount as `<AssistantRuntimeProvider runtime={runtime}><Thread /></AssistantRuntimeProvider>`.
`runtime` is the return of `useExternalStoreRuntime` (`AUI/legacy-runtime/runtime-cores/external-store/useExternalStoreRuntime.d.ts:4`).

**`AuiConfig` / `AuiProvider` are not needed.** The `AuiProvider` docs state it directly:
*"When mounting a runtime built with one of the runtime hooks, use `AssistantRuntimeProvider`
— it installs an `AuiProvider` internally — rather than wiring `AuiProvider` yourself."*
(`STORE/AuiProvider.d.ts:24-26`). `AuiConfig` only builds extra scopes for `AuiProvider`
(`STORE/AuiConfig.d.ts:7-35`); the vendored thread's `useAuiState` / `AuiIf` calls are
satisfied by the provider's internal client. The `config` prop exists for injecting extra
scopes, which this app does not need.

### Adapter fields: required vs optional

`ExternalStoreAdapter<T>` = `ExternalStoreAdapterBase<T> & (T extends ThreadMessage ? object
: { convertMessage: (message: T, idx: number) => ThreadMessageLike })`
(`CORE/runtimes/external-store/external-store-adapter.d.ts:211`, `:43`, `:51-53`).
In practice, for `T = UIMessage`, the following are **required**:

| Field | Cite | Why |
| --- | --- | --- |
| `onNew: (message: AppendMessage) => Promise<void>` | `adapter.d.ts:124` | Only non-optional callback |
| `messages: readonly T[]` **or** `messageRepository` | `adapter.d.ts:81-82` | Runtime throws otherwise (`external-store-thread-runtime-core.js:256`) |
| `convertMessage` (when `T ≠ ThreadMessage`) | `adapter.d.ts:52`, `:147` | Conditional type makes it mandatory |

Everything else is optional. The ones this app needs:

| Field | Cite | Notes |
| --- | --- | --- |
| `isRunning?: boolean` | `adapter.d.ts:79` | Drive from `status === 'streaming'` (see §5) |
| `isDisabled?: boolean` | `adapter.d.ts:61` | Vault-locked / no provider |
| `isSendDisabled?: boolean` | `adapter.d.ts:70` | Block send without disabling input/edits |
| `isLoading?: boolean` | `adapter.d.ts:80` | History fetch in flight |
| `setMessages?` | `adapter.d.ts:102` | Required for edits/cancel/delete to survive resync |
| `onEdit?` | `adapter.d.ts:127` | Enables `capabilities.edit` |
| `onReload?` | `adapter.d.ts:129` | Enables `capabilities.reload` |
| `onCancel?` | `adapter.d.ts:131` | Enables `capabilities.cancel` |
| `onDelete?` | `adapter.d.ts:128` | Enables `capabilities.delete` |
| `suggestions?` | `adapter.d.ts:92` | Drives follow-up + welcome suggestions |
| `adapters.*` | `adapter.d.ts:148-158` | Each enables one capability (§6) |
| `unstable_messageRepositoryInstance` | `adapter.d.ts:91` | Per-thread branch isolation (§8 P3/P4) |

Minimal shape (illustrative, not a code change):

```ts
const runtime = useExternalStoreRuntime<UIMessage>({
  messages,            // engine-owned, immutable updates (new array identity)
  convertMessage,      // UIMessage -> ThreadMessageLike
  isRunning,           // status === 'streaming'
  isDisabled,          // vault locked / no provider
  setMessages,         // replace the app array with the runtime's rewrite
  onNew, onEdit, onReload, onCancel, onDelete,
});
```

**Do not** enable `unstable_enableToolInvocations` (`adapter.d.ts:181`). It defaults to
`false` and exists for client-side tool execution; enabling it here would run tool
callbacks twice because the engine already owns tool dispatch (`engine.ts:100-138`).

---

## 2. Message conversion: AI SDK v7 `UIMessage` → `ThreadMessageLike`

Source shapes: `UIMessage` (`AI:1845-1869`), `UIMessagePart` union (`AI:1870`),
`TextUIPart` (`AI:1874`), `ReasoningUIPart` (`AI:1906`), `UIToolInvocation` (`AI:2028-2136`),
`ToolUIPart` (`AI:2137`), `DynamicToolUIPart` (`AI:2142`), `FileUIPart` (`AI:1949`),
`DataUIPart` (`AI:2011`).

Target shape: `ThreadMessageLike` (`CORE/runtime/utils/thread-message-like.d.ts:9-40`).

### Top-level

| `UIMessage` | `ThreadMessageLike` | Cite |
| --- | --- | --- |
| `id: string` | `id?: string` | `thread-message-like.d.ts:31` |
| `role: 'system'\|'user'\|'assistant'` | same union | `thread-message-like.d.ts:10` |
| `parts` | `content: string \| readonly Part[]` | `thread-message-like.d.ts:11` |
| `metadata.chatStatus` | **no field** — put it in `metadata.custom` | `thread-message-like.d.ts:37-49` |

There is **no message-level `parentId`** in `ThreadMessageLike`; the runtime builds the
tree from array order (`external-store-thread-runtime-core.js:236-240`).

### Part-by-part

**text** — `{type:'text', text, state?}` → `{type:'text', text}`.
Whitespace-only text parts are dropped by the converter
(`CORE/runtime/utils/thread-message-like.js:47`), so an empty placeholder renders nothing
(desirable).

**reasoning** — `{type:'reasoning', text, id?, state?}` → `{type:'reasoning', text}`.
Also dropped when blank (`thread-message-like.js:50`). Multiple reasoning parts that
should join under one parent get a shared `parentId`; the join path concatenates with
`\n\n` (`CORE/runtime/utils/external-message-conversion.js:105-113`).

**tool-call** — two source shapes, one target:

| AI SDK v7 | Target `{type:'tool-call'}` |
| --- | --- |
| `type: 'tool-<name>'` (`AI:2139`) | `toolName: part.type.slice(5)` |
| `type: 'dynamic-tool'`, `toolName` (`AI:2142-2157`) | `toolName: part.toolName` |
| `toolCallId` (`AI:2032`) | `toolCallId` (required; otherwise defaults to `tool-${generateId()}` — `thread-message-like.js:60`) |
| `input` (`AI:2048`) | `args` |
| `state: 'input-streaming'` (`AI:2040`) | `args` may be partial; `argsText` synthesized |
| `state: 'output-available'`, `output` (`AI:2084`) | `result: output`, `isError: false` |
| `state: 'output-error'`, `errorText` (`AI:2101`) | `isError: true`; put `errorText` in `result` or `metadata` |
| `state: 'output-denied'` (`AI:2122`) | `isError: true` |
| `approval` (`AI:2059`) | target `approval` has a different shape (`CORE/types/message.d.ts:236-259`); **out of scope**, this app has no approval flow |

Target tool-call fields: `toolCallId`, `toolName`, `args`, `argsText`, `result`, `isError`
(`thread-message-like.d.ts:12-27`; runtime form `CORE/types/message.d.ts:190-260`).
`ToolUIPart` has **no `argsText`** — synthesize `argsText: JSON.stringify(input ?? {})`.
`fromThreadMessageLike` does the inverse when only `argsText` is present
(`parsePartialJsonObject`, `thread-message-like.js:62-75`), so passing `args` alone is
safe; passing `argsText` alone is also safe.

**data** — `{type:'data-<name>', data, id?}` (`AI:2011`) → `{type:'data-<name>', data}` or
canonical `{type:'data', name, data}`. The converter normalizes the `data-` prefix
(`thread-message-like.js:5-12`, `:117`); `ThreadMessageLike` accepts `data-${string}`
directly (`thread-message-like.d.ts:6-8`).

**file** — `{type:'file', url, mediaType, filename?}` (`AI:1949-1983`) → `{type:'file',
data, mimeType, filename?}` (`CORE/types/message.d.ts:63-72`). Field names differ:
`url` → `data`, `mediaType` → `mimeType`. Note `attachments: [...]` is rejected for
non-user messages (`thread-message-like.js:42`); file *parts* are allowed in content for
both roles. Non-goal per the brainstorm (no attachments), so map defensively or drop.

**source** — `source-url` / `source-document` (`AI:1928`, `AI:1938`) → `{type:'source',
sourceType, ...}` (`CORE/types/message.d.ts:19-38`).

**step-start** — `AI:2008` has no target equivalent; drop it (or map to nothing).

### Status

`ThreadMessageLike.status?: MessageStatus` (`thread-message-like.d.ts:33`; enum
`CORE/types/message.d.ts:290-305`). Assistant-only: passing `status` on a non-assistant
message throws (`thread-message-like.js:43`). If omitted, the runtime computes an
auto-status via `getContentAutoStatus(content, isLast, isRunning)`
(`thread-message-like.js:80`, `auto-status.js:42`). The engine's `metadata.chatStatus`
(`src/chat/sanitize.ts:5`) is the app's own signal and should not be copied verbatim into
`status`; see §5 for the mapping.

### Which helpers exist (all exported from `@assistant-ui/react`)

| Helper | Signature | Cite |
| --- | --- | --- |
| `fromThreadMessageLike` | `(like: ThreadMessageLike, fallbackId: string, fallbackStatus: MessageStatus) => ThreadMessage` | `thread-message-like.d.ts:44`; re-export `AUI/index.d.ts:82` (tagged `@deprecated … experimental`) |
| `getExternalStoreMessages` | `<T>(input: {messages: readonly ThreadMessage[]} \| ThreadMessage \| part) => T[]` | `CORE/runtime/utils/external-store-message.d.ts:23`; exported `AUI/index.d.ts:82` |
| `useExternalMessageConverter` | `({callback, messages, isRunning, joinStrategy?, metadata?}) => ThreadMessage[]` | `CORE/react/runtimes/external-message-converter.d.ts:20-27`; exported `AUI/index.d.ts:82` |
| `unstable_convertExternalMessages` | `= convertExternalMessages(messages, callback, isRunning, metadata, cache?) => ThreadMessage[]` | `AUI/index.d.ts:343`; `CORE/react/runtimes/external-message-converter.d.ts:19` |
| `unstable_createExternalMessageConversionCache` | `() => ExternalMessageConversionCache` | `AUI/index.d.ts:344` |
| `unstable_createMessageConverter` | `createMessageConverter(callback)` → `{useThreadMessages, toThreadMessages, toOriginalMessages, useOriginalMessage…}` | `CORE/react/runtimes/createMessageConverter.d.ts:7-17`; `AUI/index.d.ts:345` |
| `bindExternalStoreMessage` | `(target, message \| message[]) => void` (no-op if already bound) | `CORE/runtime/utils/external-store-message.d.ts:15` |
| `groupPartByType` | `<TKey extends "group-..." >(map: Partial<Record<GroupPartType, readonly TKey[]>>) => (part, context?) => readonly TKey[]` | `CORE/react/utils/groupParts.d.ts:77` |
| `ExportedMessageRepository` | `{fromArray(messages: readonly ThreadMessageLike[]) => ExportedMessageRepository}` | `CORE/runtime/utils/message-repository.d.ts:17-24` |
| `INTERNAL.MessageRepository` | the `MessageRepository` class (constructor: none documented) | `AUI/internal.d.ts:7-11` (not a public top-level export) |

There is **no `unstable_convertExternalMessages` distinct from `convertExternalMessages`** —
it is a rename alias (`AUI/index.d.ts:343`). `useMessageError` is **not** exported from
`@assistant-ui/react` top level (verified: zero matches in `AUI/index.d.ts`); use
`ErrorPrimitive.Message` instead (§7).

**Recommended conversion path (Path A):** implement `convertMessage(m: UIMessage, idx) =>
ThreadMessageLike` in app code, pass it to the adapter. This keeps one conversion site,
lets `setMessages` hand back raw `UIMessage[]` (`external-store-thread-runtime-core.js:554`
calls `messages.flatMap(getExternalStoreMessages)` when `convertMessage` is set), and
avoids the second `ThreadMessage[]`-shaped pipeline.

**Alternative (Path B):** `useExternalMessageConverter` produces `ThreadMessage[]` directly
and is the only path that injects a thread-level error into status (see §7). If chosen, the
adapter must be given `messages: threadMessages` **without** `convertMessage`
(`external-store-thread-runtime-core.js:206`), and `setMessages` then receives
`ThreadMessage[]`, which the app must reverse via `getExternalStoreMessages`.

---

## 3. Edit + rerun: exact payloads, and the destructive-truncation contract

### `onEdit(message: AppendMessage)`

`AppendMessage = Omit<ThreadMessage, 'id'> & { parentId: string | null; sourceId: string |
null; runConfig: RunConfig | undefined; startRun?: boolean; steer?: boolean }`
(`CORE/types/message.d.ts:400-408`).

The edit composer builds it as (`CORE/runtime/base/default-edit-composer-runtime-core.js:48-56`):

```
{
  ...message,                              // { createdAl? no: createdAt, role, content, attachments, metadata, runConfig }
  content,                                 // edited text parts + non-text passthrough
  parentId: <parent of the edited message>,
  sourceId: <id of the edited message>,    //  <- the target message id
  startRun: options?.startRun,
}
```

- **Edited text** = the `text` parts of `message.content` (assistant-ui shape, not
  `UIMessage`). For a user message the composer was seeded with
  `getThreadMessageText(message)` (`default-edit-composer-runtime-core.js:30`), so
  `content` is normally `[{type:'text', text}]`; non-text original parts are appended
  after it (`:49`).
- **Target id** = `message.sourceId`.
- A new (non-edit) send has `sourceId: null` and `parentId` = last message id
  (`CORE/runtime/base/default-thread-composer-runtime-core.js:71-76`).
- The runtime classifies edit vs new as
  `isEdit = rawMessage.sourceId != null || rawMessage.parentId !== lastMessageId`
  (`external-store-thread-runtime-core.js:386`) and calls `onEdit` for edits
  (`:402-405`).

Map to the engine: `engine.editMessage(threadId, message.sourceId!, toUiParts(message.content))`.
Because the input is assistant-ui parts, this needs a reverse mapper:

```
thread text part      -> { type: 'text', text }
thread tool-call       -> { type: `tool-${toolName}`, toolCallId, state: result===undefined ? 'input-available' : 'output-available', input: args, output: result }
```

### `onReload(parentId: string | null, config: StartRunConfig)`

`StartRunConfig = { parentId: string | null; sourceId: string | null; runConfig: RunConfig }`
(`CORE/runtime/interfaces/thread-runtime-core.d.ts:120-124`). The reload action is built by
the message runtime as `startRun({ parentId: message.parentId, sourceId: message.id,
runConfig })` (`CORE/runtime/api/message-runtime.js:64-75`), and the runtime forwards
`onReload(config.parentId, config)` (`external-store-thread-runtime-core.js:449-454`).

So for the vendored Reload button:

- first arg = `config.parentId` = the preceding user message id;
- `config.sourceId` = the assistant message to regenerate.

Map to `engine.rerun(threadId, config.sourceId!)`. The engine truncates at the parent's
user turn and re-streams (`src/chat/engine.ts:178-185` via `baseForMessage`,
`src/chat/reducer.ts:40-47`), which is exactly `onReload` semantics. The vendored
`ActionBarPrimitive.Reload` is disabled unless `capabilities.reload` is true, i.e.
`onReload` is provided (`primitive-predicates.js:11`, `external-store-thread-runtime-core.js:167`).

### What `setMessages` must do

The runtime uses `setMessages` when it rewrites history itself — cancel restoring a draft
and deleting a message (`external-store-thread-runtime-core.js:488-505`, `:418-431`) — and
its absence is called out in the adapter docs: *"Without it, cancelling a run leaves a
trailing user message in the thread and the composer untouched"* (`adapter.d.ts:94-101`).

`setMessages(next)` receives the rewritten list. With `convertMessage` set, the runtime
hands back the original external messages:
`this._store.setMessages?.(messages.flatMap(getExternalStoreMessages))`
(`external-store-thread-runtime-core.js:554`); otherwise it hands back `ThreadMessage[]`
(`:555`). The app should write it into `useChatStore` with a **new array identity** so the
runtime's identity check re-converts (`_updateStoreSnapshot` compares
`oldStore.messages === store.messages`, `:205`).

**Interaction with destructive engine truncation.** `engine.editMessage` / `engine.rerun`
truncate and re-stream (`engine.ts:163-185`). The adapter mirrors that by resetting the
repository head to the incoming tail (`external-store-thread-runtime-core.js:278`); the
runtime does **not** delete repository messages that left the array. Consequences:

- The visible path shortens correctly (head moved back), so edit/rerun *render* right.
- But replaced assistant messages remain in the repository tree as siblings, so *branch
  count* for the new assistant message becomes 2 and `BranchPicker` (which uses
  `hideWhenSingleBranch`, `thread.aui.tsx:791`) becomes visible. This is why the brainstorm
  already decided to hide/remove the branch picker; see §8 P3.
- Because the engine replaces the assistant message with a **new id**
  (`engine.ts:245` `createMessageId()`), stale ids accumulate. Sweeping them requires a
  per-thread repository instance (`adapter.d.ts:85-91`) or remounting.

---

## 4. Thread list: `adapters.threadList` vs `useRemoteThreadListRuntime`

### Option A — `ExternalStoreAdapter.adapters.threadList` (`ExternalStoreThreadListAdapter`)

Type at `CORE/runtimes/external-store/external-store-adapter.d.ts:21-42`, data at `:13-20`.

| Method/field | Required? | Cite |
| --- | --- | --- |
| `threads: readonly ExternalStoreThreadData<'regular'>[]` | effectively yes | `:28` |
| `archivedThreads` | no | `:29` |
| `threadId` | no | `:24` (tagged `@deprecated`) |
| `isLoading` | no | `:26` |
| `onSwitchToThread(id)` | no | `:33` (tagged `@deprecated`) |
| `onSwitchToNewThread()` | no | `:30` (tagged `@deprecated`) |
| `onRename(id, title)` | no | `:35` |
| `onUpdateCustom(id, custom)` | no | `:36` |
| `onArchive` / `onUnarchive` / `onDelete` | no | `:37-41` |

Thread metadata on `ExternalStoreThreadData` (`:13-20`): `status`, `id`, `remoteId?`,
`externalId?`, `title?`, `custom?`. **No `lastMessageAt`.** `custom` is
`Record<string, unknown>`, so a workspace label fits, but the date grouping in the vendored
`thread-list.aui.tsx` needs `lastMessageAt` (`useThreadListGroups`, `thread-list.aui.tsx:136`)
— which this adapter cannot supply. `adapters.threadList` itself is tagged `@deprecated …
under active development` (`:155-157`).

### Option B — `useRemoteThreadListRuntime` (`RemoteThreadListAdapter`)

Signature: `useRemoteThreadListRuntime(options: RemoteThreadListOptions) => AssistantRuntime`
(`CORE/react/runtimes/useRemoteThreadListRuntime.d.ts:4`), with
`RemoteThreadListOptions = { runtimeHook: () => AssistantRuntime; adapter; initialThreadId?;
threadId?; onThreadIdChange?; allowNesting? }`
(`CORE/runtimes/remote-thread-list/types.d.ts:81-120`).

`RemoteThreadListAdapter` (`types.d.ts:38-79`) — **all of these are required**:

| Method | Signature | Cite |
| --- | --- | --- |
| `list` | `(params?: {after?: string}) => Promise<RemoteThreadListResponse>` | `:48-50` |
| `rename` | `(remoteId, newTitle) => Promise<void>` | `:51` |
| `archive` / `unarchive` / `delete` | `(remoteId) => Promise<void>` | `:52-54` |
| `initialize` | `(threadId) => Promise<{remoteId; externalId?}>` | `:55` |
| `generateTitle` | `(remoteId, messages) => Promise<AssistantStream>` | `:56-63` |
| `fetch` | `(threadId) => Promise<RemoteThreadMetadata>` | `:64` |
| `updateCustom?` | `(remoteId, custom) => Promise<void>` | `:52` |
| `unstable_Provider?` / `unstable_useAdapters?` | per-thread adapter injection | `:65-78` |

`RemoteThreadMetadata` (`types.d.ts:19-27`) has `status`, `remoteId`, `externalId?`,
`title?`, **`lastMessageAt?: Date`**, `custom?`. This is the only API here that carries
`lastMessageAt` and `custom` together.

### Comparison

| Dimension | `adapters.threadList` | `useRemoteThreadListRuntime` |
| --- | --- | --- |
| Deprecation | Whole `threadList` field tagged deprecated; 4 of its members deprecated | No deprecation markers |
| Required surface | `threads` array | 8 required async methods |
| Metadata | `title`, `custom`; **no `lastMessageAt`** | `title`, `custom`, **`lastMessageAt`** |
| Grouping | Date grouping impossible without patching the vendored list | Date grouping works out of the box |
| Fit to encrypted store | Direct: `listThreads()` → `threads[]` | Needs `initialize` + `fetch` + `generateTitle` streaming |
| Per-thread composition | One runtime, one adapter | `runtimeHook` called per mounted thread; per-thread adapters via `unstable_Provider`/`unstable_useAdapters` |

**Ranking for 0.15.20 (safest → riskiest):**

1. **App-owned custom list** (the brainstorm's decision). It sidesteps both deprecated and
   heavy APIs, and the grouping requirement already breaks `thread-list.aui.tsx`'s date
   buckets (`thread-list.aui.tsx:112-119`). The store already exposes everything needed.
2. **`useRemoteThreadListRuntime`** — safer than option 3 (no deprecation) and carries
   `lastMessageAt`, but requires `generateTitle` streaming and an 8-method adapter whose
   `threadId`/`onThreadIdChange` controlled pattern is extra state to own.
3. **`adapters.threadList`** — smallest code, but deprecated, missing `lastMessageAt`, and
   its date-shaped list still has to be forked.

If the app owns the left list, do **not** pass `adapters.threadList` at all: the vendored
`thread-list.aui.tsx` is then unused, and `ThreadListPrimitive` state stays empty
(`s.threads.threadIds`, `thread-list.aui.tsx:37`) with no cost.

---

## 5. Streaming render: tool parts, status, `isRunning`

### How a partial assistant message renders a tool-call part

`toMessagePartStatus(message, partIndex, part)` (`CORE/utils/normalizePartStatus.js:36-48`):

- tool-call with `result === undefined` → the part status is **the message status**;
- tool-call with a `result` → `{type:'complete'}`.

Combined with the auto-status order in `getAutoStatus` (`auto-status.js:32-39`):
`error` (last only) → `running` (last && isRunning) → interrupt → background → pending
tool-call → cancelled → complete. So a streaming assistant message whose tool call has no
result yet is `running` while `isRunning` is true, and the vendored `ToolFallback` shows the
spinner and shimmer on `status.type === 'running'` (`tool-fallback.aui.tsx:140-141`,
`:161`, `:169`). `ToolGroupTrigger` shows its loader the same way
(`thread.aui.tsx:563-564`).

### `isRunning` and the composer / action bars

- `thread.isRunning` is `getThreadRuntimeCoreIsRunning(runtime)`: if `runtime.isRunning !==
  undefined` it is used, else it falls back to the trailing assistant message's
  `status.type === 'running'` (`CORE/runtime/api/thread-runtime.js:52-57`).
- For external stores the trailing message's status is itself derived from `isRunning`
  (`auto-status.js:38`), so the fallback is circular. **Set `isRunning` explicitly** from
  `useChatStore.status === 'streaming'` (`src/chat/store.ts:5`).
- The vendored composer swaps Send/Cancel on `s.thread.isRunning`
  (`thread.aui.tsx:481`, `:496`); Cancel is a `ComposerPrimitive.Cancel` gated by
  `composerCancelDisabled = !s.composer.canCancel` (`primitive-predicates.js:8`), and
  `canCancel` requires the `onCancel` capability plus an in-flight run
  (`CORE/store/scopes/composer.d.ts:26-31`).
- Action bars use `hideWhenRunning` (`thread.aui.tsx:344`, `:637`, `:744`), so they hide
  while `isRunning`.

### Status mapping from the engine

The engine attaches two signals: `useChatStore.status` (`'idle' | 'streaming'`, `store.ts:5`)
and per-message `metadata.chatStatus` (`'streaming' | 'done'`, `sanitize.ts:5`, set at
`engine.ts:252`, `:301`, finalized at `sanitize.ts:41`). Recommended mapping:

- `isRunning = store.status === 'streaming'` (adapter level).
- In `convertMessage`, do **not** emit an explicit `status` for a normal message; let the
  auto-status run. Only emit an explicit `status` to force a terminal error state (§7).
- `metadata.chatStatus` is redundant with `isRunning` and can be carried in
  `metadata.custom` if the UI wants it; it is not a `ThreadMessageLike` field.

Do not map `chatStatus: 'streaming'` to `status: {type:'running'}` on every message — that
would keep non-last messages "running" and confuse `MessagePrimitive` renders.

---

## 6. Suppressing unrequested features in `thread.aui.tsx`

All of these are **app-owned vendored files**; the cleanest suppression is deleting the
element. The runtime flags below explain why the element is inert (or not) if left in.

| Feature | Where | Capability / adapter field | Behaviour if absent |
| --- | --- | --- | --- |
| Composer attachments | `ComposerAddAttachment` `thread.aui.tsx:447`; `ComposerAttachments` `:428` | `adapters.attachments` → `capabilities.attachments` (`external-store-thread-runtime-core.js:173`) | Button still renders: `useComposerAddAttachment` disables on `!s.composer.isEditing` (`CORE/react/primitive-hooks/useComposerAddAttachment.js:29`), and `isEditing` is `true` on the normal composer (`base-composer-runtime-core.js:11`). Adding a file throws `"Attachments are not supported"` (`base-composer-runtime-core.js:283`) but the button's handler swallows it (`ComposerAddAttachment.js:41`). **Must remove the JSX.** |
| Dictation | `thread.aui.tsx:449` | `adapters.dictation` → `capabilities.dictation` (`external-store-thread-runtime-core.js:171`) | `AuiIf` hides it automatically; no adapter needed |
| Feedback (thumbs) | `thread.aui.tsx:651` | `adapters.feedback` → `capabilities.feedback` (`:174`) | `AuiIf` hides automatically |
| Branch picker | `thread.aui.tsx:627`, `:733` | `capabilities.switchToBranch` (true iff `setMessages`, `:163`); `switchBranchDuringRun: false` (`:164`) | Hidden only while `branchCount <= 1` (`hideWhenSingleBranch`, `:791`). With destructive edit/rerun it **does** become visible — remove the component (§8 P3) |
| Follow-up suggestions | `ThreadFollowupSuggestions` `thread.aui.tsx:236`; `follow-up-suggestions.aui.tsx:72-81` | `adapter.suggestions` (`adapter.d.ts:92`) | Hidden when `s.thread.suggestions.length === 0`; never provide `suggestions` |
| Welcome suggestions | `thread.aui.tsx:238-240` | `adapter.suggestions` | Same; hidden while empty |
| Reload (per message) | `thread.aui.tsx:669` | `onReload` → `capabilities.reload` (`:167`) | Disabled, not hidden (`actionBarReloadDisabled`, `primitive-predicates.js:11`) — **wanted**, keep |
| Edit (user message) | `thread.aui.tsx:748` | `onEdit` → `capabilities.edit` (`:165`) | Disabled when `!capabilities.edit` — **wanted**, keep |
| Copy / Export markdown | `thread.aui.tsx:641`, `:689` | `unstable_capabilities.copy !== false` (`:172`) | Always on; set `unstable_capabilities: {copy:false}` only if unwanted |
| Speech / voice | not rendered in `thread.aui.tsx` | `adapters.speech` / `adapters.voice` | No `AuiIf` in this file; nothing renders |
| Attachments in thread list | none | — | — |

So: **dictation, feedback, and suggestions need no code change** (their `AuiIf` conditions
are false without adapters). **Attachments and the branch picker must be removed from the
vendored JSX**; the capability flags do not hide them.

The brainstorm's non-goals map cleanly: no `attachments`/`dictation`/`feedback`/`speech`/
`voice` adapters, no `suggestions`, and `unstable_capabilities.copy` left at its default.

---

## 7. Error surfacing

### How `MessagePrimitive.Error` / `ErrorPrimitive` get content

- `MessagePrimitive.Error` renders children only when `useMessageError() !== undefined`
  (`AUI/primitives/message/MessageError.js:5-7`; component also declared at
  `AUI/primitives/message/MessageError.d.ts:4`).
- `ErrorPrimitive.Message` renders `children ?? String(error)` and returns `null` when the
  error is `undefined` (`AUI/primitives/error/ErrorMessage.js:7-20`).
- Both read `useMessageError`, which is `useAuiState(messageErrorText)`
  (`CORE/react/primitive-hooks/useMessageError.js:4-6`), and `messageErrorText` is
  (`CORE/store/primitive-predicates.js:16-22`):

```js
const messageErrorText = (s) => {
  if (s.message.status?.type !== "incomplete" || s.message.status.reason !== "error") return;
  const error = s.message.status.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error
      && typeof error.message === "string") return error.message;
  return error ?? "An error occurred";
};
```

So the **only** channel is `message.status.error` on an `incomplete`/`error` status
(`CORE/types/message.d.ts:290-297`). The vendored `MessageError` is already mounted inside
every assistant message (`thread.aui.tsx:620`, `:514-522`).

### Can a thread-level error be shown from external state?

There is **no thread-level error field**. `ThreadState` has `threadId`, `metadata`,
`isDisabled`, `isLoading`, `isRunning`, `capabilities`, `messages`, `state`, `suggestions`,
`extras`, `speech`, `voice` — and no error (`CORE/runtime/api/thread-runtime.d.ts:49-99`).
`RuntimeCapabilities` likewise has no error member
(`CORE/runtime/interfaces/thread-runtime-core.d.ts:14-30`). Routing `engine.error`
(`src/chat/store.ts:11`) into the thread UI therefore means one of:

1. **Project onto the last assistant message's status** in `convertMessage`: when
   `useChatStore.error` is set and this is the last assistant message, return
   `status: {type:'incomplete', reason:'error', error: <string>}`. `ErrorPrimitive.Message`
   then renders it. This needs the converter to read the store (keep the callback stable
   and read via `useChatStore.getState()` so identity does not churn — see §8 P1/P2).
2. **Use Path B (`useExternalMessageConverter`)**, whose metadata carries `error`:
   `metadata.error` flows into `getAutoStatus(…, isLast ? error : undefined, …)`
   (`CORE/runtime/utils/external-message-conversion.js:176`) and, when the last message is
   not an assistant message, a synthetic error assistant message is appended
   (`createErrorAssistantMessage`, `:199-221`; `completeExternalMessageConversion`, `:224`).
3. **Render a separate banner** outside `ThreadPrimitive` from `useChatStore.error`. Simplest
   and keeps the thread error-free; recommended if the engine error should appear above the
   composer rather than inside the last message.

### Is there a `setMessages`-adjacent error path?

Only for **send rejection**. If `onNew` rejects with `MessageNotSentError`
(`CORE/types/error.d.ts:33-43`), the composer restores the draft it cleared at dispatch
(`base-composer-runtime-core.js` `_restoreUnsentDraft`; adapter docs `adapter.d.ts:124`).
Any other `onNew`/`onEdit` rejection propagates to the caller. `onCancel` rejections are
logged by `observeAdapterCallback` and do not surface
(`external-store-thread-runtime-core.js:18-22`, `:484`). There is an `AssistantError` type
with `severity`/`display` (`CORE/types/error.d.ts:3-9`) and `toAssistantError`, but it is
not wired into `ThreadState` in 0.15.20.

**Recommendation:** option 3 (app banner from `useChatStore.error`) for the primary
surface, with option 1 if the requirement is specifically "the error appears in the failed
assistant message".

---

## 8. Pitfalls (0.15.20 specifics)

**P1 — object-literal selectors re-render every store update.**
`useAuiState`'s selector result is compared with `Object.is`; *"Returning a new object or
array literal, including spreading `s.thread` into a new object, causes a re-render on
every store update."* (`STORE/useAuiState.d.ts:9-13`). Return primitives or memoized refs.
The vendored `reasoning.aui.tsx:66-74` returns a boolean (fine); the vendored
`use-attachment-src.ts:33-43` wraps a multi-field selector in `useShallow` from
`zustand/react/shallow` — the pattern to copy when a selector must return an object.

**P2 — `useAuiState` stability rule.** The selector is called on every store update; it must
be cheap and referentially stable for equal inputs. *"Returning the entire state object is
not supported and throws at runtime."* (`STORE/useAuiState.d.ts:8-11`). For a converter
that needs the current error, read `useChatStore.getState()` inside the callback instead of
closing over a reactive value.

**P3 — destructive edit/rerun creates phantom branches, and `BranchPicker` appears.**
`engine.editMessage`/`rerun` replace the assistant message with a new id (`engine.ts:245`)
and truncate (`engine.ts:163-185`). The runtime's `_updateStoreSnapshot` adds/updates
incoming messages but only deletes ids tracked in `_pendingDeleteEvictions`
(`external-store-thread-runtime-core.js:236-252`); it resets the visible head to the
incoming tail (`:278`). The replaced message therefore survives in the repository as a
sibling, `branchCount` becomes 2, and `BranchPickerPrimitive.Root hideWhenSingleBranch`
(`thread.aui.tsx:791`) stops hiding. **Mitigation:** delete the `BranchPicker` usage from
the vendored thread (already the brainstorm's decision), or supply
`unstable_messageRepositoryInstance` (`adapter.d.ts:85-91`) and rebuild it per thread.

**P4 — one runtime, many conversations: repository bleed-through.**
`useExternalStoreRuntime` creates a single `ExternalStoreRuntimeCore` and keeps it
(`CORE/react/runtimes/useExternalStoreRuntime.js:28`, `:40-45`); the message repository
accumulates across thread switches. The adapter's own docs describe the fix: *"hosts that
route multiple conversations through one runtime keep each conversation's history and
branches isolated in its own instance"* (`adapter.d.ts:86-90`). Provide one
`MessageRepository` per thread via `unstable_messageRepositoryInstance`. The class is not
a public export — reach it through `INTERNAL.MessageRepository`
(`AUI/internal.d.ts:7-11`) or `ExportedMessageRepository` for the imported shape
(`CORE/runtime/utils/message-repository.d.ts:17-24`). Alternative: remount the provider
with `key={threadId}` (loses runtime continuity per switch).

**P5 — `content-visibility: auto` on message roots.**
Every message root carries `[contain-intrinsic-size:auto_200px] [content-visibility:auto]`
(`thread.aui.tsx:541`, `:717`, `:761`; voice rows use `auto_48px` at `:292`). Two real
effects for a long chat: (a) off-screen messages are not rendered, so browser find-in-page
and text selection miss them; (b) a wrong 200px intrinsic estimate makes scroll position
jump when a tall off-screen message enters the viewport, which interacts with
`ThreadPrimitive.Viewport turnAnchor="top"` (`thread.aui.tsx:202`) and
`ScrollToBottom` (`:364`). assistant-ui ships **no virtualizer** (no `virtualiz*` matches
under `AUI/`), so this is content-visibility alone, not virtualization. The vendored markup
is app-owned; raise the intrinsic size or drop `content-visibility` if scroll anchoring
misbehaves. Runtime behaviour under long threads is UNVERIFIED without a browser.

**P6 — markdown `defer` and `smooth`.**
The vendored `MarkdownText` passes `defer` (`markdown-text.tsx:55`), documented as: defers
parsing via `useDeferredValue` so typing/scrolling is not blocked, *"Intermediate streaming
states may be skipped under load; the final text always renders"*, and *"Must stay constant
for the lifetime of the component: the deferred path is a separate component, so toggling
this remounts the rendered markdown"* (`AIMD/primitives/MarkdownText.d.ts:37-45`). `defer`
is a hard-coded literal here, so the remount trap is avoided — but keep it constant.
`smooth` defaults to `true` (`AIMD/primitives/MarkdownText.d.ts:27-34`), giving a typing
reveal; combined with `defer` the visible text can lag the engine's streamed content.

**P7 — React Compiler is enabled.**
`vite.config.ts:63` runs `babel({ presets: [reactCompilerPreset()] })` from
`@vitejs/plugin-react` (`vite.config.ts:2`, `:60-64`). assistant-ui ships precompiled with
its own compiler runtime (`@assistant-ui/tap/react-shim` `c()`, visible in every
`AUI/**/*.js`), so the app pass should not double-compile the library. What it *does*
compile is the vendored app-owned element files, which contain patterns the compiler may
rewrite: a ref mutated during render (`useShallowStable`, `markdown-text.tsx:24-38`),
conditional `setState` during render (`tool-fallback.aui.tsx:693-699`), and `useMemo` /
`useCallback` with non-trivial deps. `pnpm exec tsc -b` currently exits 0 over `src`
(verified in this session), so types are clean; runtime behaviour under the compiler pass is
UNVERIFIED without a browser smoke test.

**P8 — omitting `isRunning` is not a safe default.** See §5: `getThreadRuntimeCoreIsRunning`
falls back to the trailing assistant status (`thread-runtime.js:52-57`), but that status is
derived from `isRunning` (`auto-status.js:38`). Always pass it.

**P9 — duplicate message ids are silently deduped.** The runtime warns and keeps the **last**
occurrence (`external-store-thread-runtime-core.js:231`). The engine generates ids with
`crypto.randomUUID` (`engine.ts:83-88`), so this is only a risk if `UIMessage.id` is reused
across an edit/rerun.

**P10 — tool `argsText` and whitespace text parts.** `ToolUIPart` has no `argsText`
(`AI:2137-2141`, `AI:2028-2138`), so it must be synthesized; whitespace-only text and
reasoning parts are dropped by the converter (`thread-message-like.js:47`, `:50`).

**P11 — `setMessages` is required for cancel/delete to stick.** Without it, cancel leaves a
trailing user message and the composer untouched (`adapter.d.ts:94-101`;
`external-store-thread-runtime-core.js:554-555`).

**P12 — no browser test harness.** Vitest runs `environment: 'node'` with only
`fake-indexeddb` (`vitest.config.ts:4-9`); there is no jsdom, no `@testing-library/*`, and no
browser runner. The assistant-ui runtime, effects, portals, and `content-visibility`
behaviour cannot be covered by the current suite — only pure converters/reducers and
server-render smoke. This bounds what "verified" can mean for the integration.

**P13 — v0.15 breaking-change surface for the external store.**
Concrete, citable changes/deprecations in the installed version:
`adapters.threadList` and four of its members are deprecated
(`external-store-adapter.d.ts:24`, `:30`, `:33`, `:155-157`); `ExternalStoreBranchChange` /
`unstable_onBranchChange` are deprecated (`:106-119`); `isLoading` now sits both on the
adapter (`:80`) and on the thread-list adapter (`:26`); `isSendDisabled`
(`:70`) and `unstable_messageRepositoryInstance` (`:91`) are new relative to older
examples; and the React surface is the `useAuiState` / `AuiIf` / `AuiProvider` client API
(`AUI/index.d.ts:76`), which the vendored files already use. A packaged CHANGELOG is **not
shipped** in `@assistant-ui/react` or `@assistant-ui/core` (verified: no `CHANGELOG*` file),
so any additional 0.15 breaking changes are UNVERIFIED from the install and would require
the upstream release notes.

---

## UNVERIFIED / open questions

1. **Runtime behaviour under React Compiler** for the vendored element files (P7). Only
   `tsc -b` was run; nothing renders yet. Needs a browser smoke test.
2. **`content-visibility` scroll anchoring** (P5) with real long threads; no browser run
   was possible in this session.
3. **Exact 0.15 breaking-change list** beyond the deprecated markers (P13); no changelog is
   packaged and no upstream notes were fetched.
4. **Whether `MessageRepository` construction is safe via `INTERNAL`** (P4) — the class is
   typed and exported (`AUI/internal.d.ts:7-11`) but its constructor signature is not shown
   in the typings; confirm before relying on `unstable_messageRepositoryInstance`.
5. **`generateTitle` streaming contract** for `RemoteThreadListAdapter`
   (`types.d.ts:56-63`) if the remote path is chosen instead of a custom list — the
   required `AssistantStream` shape was not traced.
6. **`approval` / `interrupt` tool parts** are fully typed in both stacks
   (`AI:2059`, `CORE/types/message.d.ts:236-259`) but out of scope; the mapping in §2 is
   the no-approval subset only.
7. **`onDelete` semantics against the encrypted store**: the adapter passes only a
   `messageId` (`adapter.d.ts:128`) and this app has no message-level delete in the engine
   API (`src/chat/engine.ts:45-51`), so wire it to `setMessages` or leave it unset.

---

## Ranked recommendation

1. **Single `useExternalStoreRuntime` + adapter `convertMessage`**, one array in
   `useChatStore`, `isRunning` from `status === 'streaming'`, `setMessages` implemented,
   `onNew`/`onEdit`/`onReload`/`onCancel` mapped to `sendTurn`/`editMessage`/`rerun`/`cancel`,
   and `onDelete` left unset.
2. **Mount one `AssistantRuntimeProvider`**; no `AuiConfig`/`AuiProvider`.
3. **Custom left list** (no `adapters.threadList`), per the brainstorm.
4. **Remove `ComposerAddAttachment`, `ComposerAttachments`, and `BranchPicker`** from
   `thread.aui.tsx`; leave dictation/feedback/suggestions inert by not supplying adapters.
5. **Surface `useChatStore.error` as an app banner**, optionally mirroring it onto the last
   assistant message status for the inline error primitive.
6. **Reach for `unstable_messageRepositoryInstance`** only if multi-thread branch leakage
   (P4) shows up in testing.
