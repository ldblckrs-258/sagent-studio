# Brainstorm: Core Chat Engine

- Date: 2026-09-19
- Status: accepted (post red-team)
- Scope: `sagent-studio` (browser-only Vite SPA, on top of Plan 1)
- Plan: `plans/260919-0828-core-chat-engine`

## Summary

The app has an encrypted vault, provider registry, and `createLLM` factory but no
chat logic. This ticket adds the execution core: streaming chat with a configurable
system instruction and model parameters, deterministic history editing (undo,
rerun, edit both sides), skill injection, local-folder file tools, and sandboxed
JavaScript/Python runners. No UI is built. The core owns a plain `UIMessage[]` so a
later assistant-ui ticket can bridge it with `useExternalStoreRuntime` without a
rewrite.

## Contract

**Outcome.** UI-agnostic engine modules under `src/chat`, `src/skills`,
`src/tools`, `src/workspace`, and `src/sandbox` that drive a streaming, tool-using
chat over the existing provider factories, with per-thread configuration, editable
history, and encrypted persistence.

**Constraints.**

- Browser-only; matches the existing vault/Dexie/WebCrypto architecture.
- The vault `CryptoKey` never enters a worker.
- The workspace handle is persisted in IndexedDB (user decision) and sandbox code
  can reach it; path validation still applies to main-thread tools.
- File access is confined to the granted folder for main-thread tools; traversal is
  rejected and permission is re-checked per operation.
- Core testable in node via injected fakes; a worker factory makes runner
  lifecycle unit-testable; real-browser checks are a named blocking artifact.
- No secrets in logs, errors, or persisted plaintext.

**Non-goals.** Chat UI; RAG/TypeSafe (Plan 2); sync/accounts; remote execution;
MCP client; neutralizing worker network egress or a worker reading the persisted
handle (both accepted residual risks); Firefox/Safari folder parity.

**Acceptance criteria.** The eight criteria in `plan.md`, covering streaming and
config, reducer operations including a middle-assistant rerun, skill injection,
path and handle safety, runner output and timeout with pending-RPC rejection,
encrypted persistence and abort rehydration, and lint/build/test.

## Verified environment evidence

- Vite 8.3.0, React 19.2.8, TS 6.0.3, Dexie 4.4.6, Vitest 5.0.1 (node +
  `fake-indexeddb`).
- `ai@7.0.105` exports `streamText`, `tool`, `jsonSchema`, `stepCountIs`,
  `convertToModelMessages`, `toUIMessageStream`, `readUIMessageStream`,
  `UIMessage`; `ai/test` exports `MockLanguageModelV4`. `streamText` takes
  `temperature/topP/...` top-level and defaults to `stepCountIs(1)`.
- `ChatTransport` is not needed: `useChatRuntime` is absent from installed
  `@assistant-ui/react@0.15.20`; the installed bridge is `useExternalStoreRuntime`
  with an app-owned array, and assistant-ui has no undo primitive.
- Existing core: `createLLM` (`src/ai/llm.ts:8`), vault key module-private
  (`src/vault/store.ts:49`), Dexie `version(1)` (`src/vault/db.ts:28`),
  `createWriteQueue` (`src/vault/write-queue.ts:7`).
- HTML §7.1.7 + WPT: a same-origin `http(s)` worker does not inherit the document
  CSP; a `<meta>` policy cannot reach it.
- `CryptoKey` and `FileSystemDirectoryHandle` are structured-cloneable; a worker
  can read any same-origin IndexedDB.
- Pyodide 314.0.7 core is ~13.2 MiB; module worker required; `Worker.terminate()`
  is the only timeout without COOP/COEP.

## Approaches considered

**Engine seam.** (A) AI SDK primitives with an app-owned `UIMessage[]` — chosen.
(B) `ToolLoopAgent` + `DirectChatTransport` — a second state owner and weaker undo
control. (C) hand-rolled loop — most code, reinvents stop/tool handling.

**History/undo.** (A) immutable reducer with primitive ops — chosen. (B) snapshot
undo stack — heavier and conflates undo with edit.

**Skill/tool import.** (A) SKILL.md bundles plus user tool definitions of two
kinds (`sandbox-js` and hardened `http`) — chosen. (B) raw JS modules on the main
thread — rejected, breaks worker isolation. (C) instruction-only skills — does not
meet the requested scope.

**Persistence.** (A) per-thread encrypted Dexie records through a shared vault
write queue — chosen. (B) all threads in the settings blob — rejected. (C) separate
DB and key — rejected.

**Handle storage.** (A) persisted in a Dexie `fs` table (user decision) — chosen;
sandbox reach is an accepted residual risk. (B) session-memory only — rejected by
user choice. (C) separate origin — not possible for a static SPA.

## Chosen architecture

```
src/vault/keyring.ts     key + generation as one atomic pair (single source)
src/vault/records.ts     encryptRecord/decryptRecord, AAD per record
src/chat/
  types.ts               ChatThread, ThreadConfig, ModelParams, SkillRef, defaults
  reducer.ts             pure history ops incl. baseForMessage
  context.ts             composeSystemPrompt (trusted/untrusted split)
  sanitize.ts            abort/rehydrate sanitization
  persistence.ts         Dexie v2 threads via vaultWriteQueue
  store.ts               zustand app-owned state + lock subscription
  engine.ts              send/edit/rerun/undo/cancel over streamText
  transport.ts           thin ChatTransport<UIMessage> adapter
src/skills/{schema,parser,registry,store,workspace-source}.ts
src/tools/{types,registry,store,http}.ts + builtin/{workspace,code}.ts
src/workspace/{handle,fs,errors,fake-handle}.ts
src/sandbox/{types,protocol,worker-factory,js-worker,js-runner,py-worker,py-runner}.ts
```

**Flow.** The main thread builds the system prompt and one `ToolSet` from thread
config and enabled skills, calls `streamText` with `convertToModelMessages` (with
`ignoreIncompleteToolCalls`) and `stopWhen: stepCountIs(maxSteps)`, folds
`toUIMessageStream` chunks into the assistant message, and persists the encrypted
thread through the vault write queue on finish or abort. File/code tools route
through the workspace and the worker bridge.

## Key decisions

- Phase 1 runs a worker spike (eval/WASM/terminate, plus fetch/IndexedDB reach)
  before any runner code.
- Document CSP stays strict; only `worker-src 'self'` is added. Worker network
  egress is an accepted, documented residual risk.
- The folder handle is persisted (user decision); a worker can reach it. Main-thread
  tools still validate paths and permission.
- `http` user tools are kept with a host allow-list, no authority/header-name
  interpolation, resolved-origin check, and a response cap.
- A thin `ChatTransport` adapter is included for future `useChat` use.
- Record writes share a lock-drained queue; keyring is the single generation owner.
- Skill trust split: workspace instructions are untrusted and labeled; skills can
  only narrow the enabled tool pool.
- Encrypted per-record storage with AAD; titles encrypted.

## Recommendation

Approach A across every fork. Load-bearing assumptions: (1) same-origin worker CSP
non-inheritance, gated by the Phase 1 spike; (2) `useExternalStoreRuntime` accepts
an app-owned array, confirmed by installed types and deferred to the UI ticket.

## Risks and unresolved questions

| Risk / unknown | Handling |
|----------------|----------|
| Live-browser worker CSP behavior | Phase 1 spike gate; re-plan on failure. |
| Worker egress / IndexedDB reach | Accepted residual risk (user decision); no key is reachable; only explicit tool inputs cross the bridge. |
| Persisted handle readable by sandbox code | Accepted residual risk (user decision); main-thread tools still validate paths. |
| Key/generation desync or write-after-lock | Keyring single source; shared lock-drained queue. |
| Concurrent saves reorder | Global FIFO queue serializes encrypt+put. |
| Pyodide cold start / reload cost | Lazy load; warm worker; terminate only on timeout. |
| Workspace-skill prompt injection | Untrusted block + explicit enable + tool narrowing + tests. |
| Folder picker Chromium-only | Feature detect; typed degradation. |
| Runner lifecycle untestable in node | Injectable worker factory. |
| AAD has no rollback protection | Accepted limitation; a local IDB writer already has broader power. |
