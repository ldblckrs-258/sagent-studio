---
phase: 6
title: "Chat Engine"
status: done
priority: P1
effort: "8h"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Chat Engine

## Goal

Wire threads, persistence, skills, tools, and runners into a streaming engine that
executes turns over `streamText`, owns an app-controlled `UIMessage[]`, and exposes
send, edit, rerun, undo, and cancel — with abort, lock, and rehydrate paths that
never poison a thread.

## Context

- AI SDK v7: `streamText`, async `convertToModelMessages`, `stepCountIs`,
  `toUIMessageStream`, `readUIMessageStream` (`reports/researcher-02:26-234`).
- `streamText` defaults to `stepCountIs(1)`; the thread config must pin a higher
  cap (`node_modules/ai/dist/index.d.ts:3508`; `defaultThreadConfig` in Phase 1).
- `UIMessage` has no `status` field; partial state lives in `metadata`
  (`ai/dist/index.d.ts:1845-1867`).
- `convertToModelMessages` accepts `ignoreIncompleteToolCalls` and must receive the
  same `ToolSet` as `streamText`.
- The engine method table, `baseForMessage`, `composeSystemPrompt`, and error names
  are frozen in Phase 1.

## Requirements

Functional:

- `createEngine(deps)` returns `{ sendTurn, editMessage, rerun, undo, cancel }`.
- `sendTurn(threadId, text)` appends a user message and streams an assistant turn.
- `editMessage(threadId, messageId, parts)` replaces parts and truncates
  downstream; if the edited message is a `user` message it immediately runs an
  assistant turn, and if it is an `assistant` message it saves only (the caller
  reruns explicitly). This rule is identical in Phase 1.
- `rerun(threadId, messageId)` uses `baseForMessage(messages, messageId)` so a
  middle assistant message regenerates from its own parent user message.
- `undo(threadId)` removes the last turn.
- `cancel(threadId)` aborts the in-flight run, sanitizes the partial assistant
  message, and persists it.
- The run resolves skills, composes the system prompt, builds the `ToolSet` once,
  converts messages with `ignoreIncompleteToolCalls: true`, streams, folds chunks
  into the assistant message, and persists on finish/abort.
- `rehydrateThread` sanitizes a loaded thread: assistant `metadata.chatStatus ===
  'streaming'` becomes `'done'`, and any non-terminal tool part is dropped or
  marked `output-error` so the next request is valid.
- The store drops threads and aborts runs on vault lock; a `VaultLockedError` during
  persist drops the thread and sets `status: 'idle'` without an unhandled rejection.
- `createChatTransport(deps)` implements a thin `ChatTransport<UIMessage>`:
  `sendMessages` runs one pipeline pass and returns the `toUIMessageStream` chunk
  stream; `reconnectToStream` resolves `null`. This keeps the engine usable by
  `useChat`/`@assistant-ui/ai-sdk` later without rewriting the store.

Non-functional:

- The engine imports no React.
- The same `ToolSet` reference is passed to `convertToModelMessages` and
  `streamText`.
- Errors are typed and sanitized; provider errors never include the API key.

## Architecture

```
src/chat/store.ts      zustand: threads, activeThreadId, status, error, lock sub
src/chat/engine.ts     createEngine(deps) -> frozen method table
src/chat/transport.ts  createChatTransport(deps) -> ChatTransport<UIMessage>
src/chat/sanitize.ts   rehydrateThread + sanitizePartial + message status metadata
```

Pipeline:

```
resolveContext(thread, deps)
  -> skills = skillRegistry.resolve(enabled refs)
  -> system = composeSystemPrompt(config.systemInstruction, skills, toolNames)
  -> toolSet = toolRegistry.buildToolSet(skillNarrowedNames, ports)   // built once
-> model = createLLM(settings, config.providerId, config.modelId)
-> messages = await convertToModelMessages(thread.messages, { tools: toolSet, ignoreIncompleteToolCalls: true })
-> streamText({ model, system, messages, tools: toolSet,
                stopWhen: stepCountIs(config.maxSteps), ...config.params })
-> toUIMessageStream({ stream: result.stream, tools: toolSet, originalMessages: thread.messages })
-> readUIMessageStream -> update assistant UIMessage in store (metadata.chatStatus)
-> on finish/abort: sanitizePartial -> saveThread (serialized queue)
```

`deps`: `{ getSettings, threadStore, skillRegistry, toolRegistry, workspace, codeRunner, modelFactory? }`.
`modelFactory` defaults to `createLLM` and is replaced by a mock in tests.

## Files to Create / Modify

- Create: `src/chat/store.ts`
- Create: `src/chat/engine.ts`
- Create: `src/chat/transport.ts`
- Create: `src/chat/sanitize.ts`
- Create: `src/chat/sanitize.test.ts`
- Create: `src/chat/engine.test.ts`
- Create: `src/chat/transport.test.ts`
- Modify: `src/vault/db.ts` (confirm version is 4; no further bump in this phase)

## Implementation Steps

1. Add `src/chat/sanitize.ts`: `sanitizePartial(message)` (drop/mark non-terminal
   tool parts, set `metadata.chatStatus = 'done'`) and `rehydrateThread(thread)`
   (validate shape, apply `sanitizePartial` to any `streaming` assistant message).
2. Add `src/chat/store.ts`: zustand with `threads`, `activeThreadId`, `status`,
   `error`, and actions delegating to the reducer and persistence. Subscribe to
   `useVaultStore`; on non-unlocked, abort all runs and clear threads.
3. Add `src/chat/engine.ts` implementing the frozen method table and pipeline.
   Build the tool set once; pass it to both conversions; thread an
   `AbortController` per thread.
4. Implement edit/rerun/undo exactly per the frozen contract, using
   `baseForMessage` for rerun.
5. Implement persist-on-finish/abort with `sanitizePartial`; catch
   `VaultLockedError`, drop the thread, and set `status: 'idle'`.
6. Add `src/chat/transport.ts`: `createChatTransport(deps)` returns
   `{ sendMessages, reconnectToStream }` where `sendMessages` runs one pipeline
   pass and returns `toUIMessageStream(...)`, and `reconnectToStream` resolves
   `null`.
7. Tests (`engine.test.ts`) with `MockLanguageModelV4`:
   - Text turn streams and persists.
   - System instruction and `temperature`/`topP`/`maxOutputTokens` reach
     `model.doStreamCalls[0]`; `maxSteps` default is honored.
   - A tool step then a text step (skill enabled) executes the registered tool;
     `doStream` array length equals step count.
   - Edit a user message: downstream truncated and rerun.
   - Edit an assistant message: no auto-rerun.
   - Rerun a middle assistant message: regenerates from its own parent, no
     duplication.
   - Undo removes the last turn.
   - Cancel mid-tool-loop, then rehydrate + send again: conversion succeeds
     (asserts `ignoreIncompleteToolCalls` + sanitize).
   - Vault lock mid-run: aborts, clears, no unhandled rejection.
8. Tests (`sanitize.test.ts`): dangling tool part dropped/marked; `streaming`
   becomes `done`. Tests (`transport.test.ts`): `sendMessages` returns a chunk
   stream that folds to the assistant message; `reconnectToStream` resolves `null`.
9. `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] `src/chat/sanitize.ts` + tests
- [x] `src/chat/store.ts` (lock subscription)
- [x] `src/chat/engine.ts` (single ToolSet, capped loop)
- [x] `src/chat/transport.ts` + tests
- [x] `engine.test.ts` (stream, params, tool loop, edit both sides, rerun middle, undo, abort, lock)
- [x] lint / build / full test green

## Verification

- `pnpm test -- src/chat` passes, including abort-rehydrate, middle-rerun, and
  transport.
- `pnpm test` full suite green.
- Journal (browser): with a real provider, send a turn, edit a user message, rerun
  an assistant turn, undo, and confirm persistence across reload.
- Grep gate: `src/chat/engine.ts`, `src/chat/store.ts`, `src/chat/transport.ts`
  import no React.

## Success Criteria

- All eight plan acceptance criteria are satisfied.
- The engine streams with the configured instruction and parameters.
- Edit, rerun, and undo are deterministic and persist.
- A skill changes both the system prompt and the model's tool set.
- Abort and lock leave a recoverable thread and a clean store state.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `convertToModelMessages` and `streamText` diverge on tools | Build once, pass the same reference; a test asserts a `toModelOutput`-style tool still converts. |
| Abort poisons history | `sanitizePartial` + `ignoreIncompleteToolCalls` + rehydrate test. |
| Concurrent runs in one thread | One `AbortController` per thread; a new run cancels the prior. |
| Lock during persist | Catch `VaultLockedError`, drop thread, set idle; test asserts no unhandled rejection. |
| Provider error leaks a key | Redaction helper before setting `error`. |

## Security Considerations

- API keys stay in `settings` and pass only to `createLLM`; the settings object is
  never logged.
- Tool and file results are untrusted; the prompt treats them as data.
- Lock aborts runs so plaintext stays in memory no longer than necessary.

## Next Steps

The UI ticket bridges `useExternalStoreRuntime` to this engine's frozen methods and
renders tool calls with the installed assistant-ui elements.
