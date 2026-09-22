# Research 02 — Harness integration seams for a client-side RAG library

Scope: what the sagent-studio codebase and its pinned runtime packages provide for a
new encrypted document library, remote embeddings, and a new harness `ToolProvider`.
Read-only investigation; no designs are proposed here, only the exact seams and the
evidence for them. All claims cite `file:line`. Version pins are from
`package.json` (openai-compatible 3.0.52, ai 7.0.105, dexie 4.4.6, vite 8.3.0,
vitest 5.0.1).

---

## 1. Tool provider integration

### The provider contract

A builtin provider implements `ToolProvider` exactly as declared in
`src/tools/types.ts:235-239`: a readonly `names` array, an `isAvailable(ports)`
predicate, and `create(name, ports): Tool`. `create` must return an `ai` `Tool`
and switch on the requested name, throwing `ToolNotFoundError` for an unknown one
(`src/tools/builtin/preview.ts:58-97` for a one-name example;
`src/tools/builtin/check.ts:26-79` is the same shape; `src/tools/builtin/code.ts:6`
and `src/tools/builtin/history.ts:10` show multi-name providers). The four
proposed names (`list_documents`, `search_documents`, `get_chunk`,
`verify_citation`) satisfy `TOOL_NAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/`
(`src/tools/types.ts:283`), which `ToolRegistry.registerProvider` enforces on
every name before inserting (`src/tools/registry.ts:67-76`).

Tool return values should be built with `toolOk` / `toolFail` and wrapped with
`wrapToolExecute`, so a thrown `ToolRuntimeUnavailableError` propagates but every
other error becomes a structured `ToolResult` (`src/tools/result.ts:56-139`,
notably `toToolResult` re-throwing `ToolRuntimeUnavailableError` at line 103).
`preview.ts:73-91` and `check.ts:41-73` are the canonical call shapes.

### Where to register

The single registration site is `createSession` in `src/session/session.ts:230-243`,
the `if (!options.toolRegistry) { toolRegistry.registerProvider(...) }` block. A new
provider must also be appended to the provider list used by the Tools and Approvals
panels: `builtinProviders()` at `src/session/session.ts:312-347`, specifically the
array literal at lines 325-338. `describeBuiltinTool` (`session.ts:55-72`) catches a
`create` that throws (lines 67-71), so a provider that refuses to build while
unconfigured still lists with `available: false`; `preview.ts` and `check.ts` rely on
this.

### Adding a new optional port

`ToolRuntimePorts` is a flat optional-property interface at `src/tools/types.ts:219-233`.
Adding a port is a five-point edit:

1. Add the async interface to `src/tools/types.ts` and an optional field to
   `ToolRuntimePorts` (types.ts:219-233). Existing precedent for an async port is
   `workspace?: WorkspaceApi` (types.ts:223).
2. Declare the field on `PipelineDeps` in `src/chat/engine.ts:65-85` (the
   `workspace?`, `codeRunner?`, `sandbox?`, `preview?` block), because `EngineDeps`
   only adds `threadStore` on top (`engine.ts:101-103`).
3. Thread it into the `ports` object that `buildRunStream` hands to the registry,
   `src/chat/engine.ts:329-345`, and therefore into `buildToolSet` at line 365.
4. Supply it on the `deps: EngineDeps` object in `createSession`,
   `src/session/session.ts:245-263`. Note the existing entries there are getters
   (`get workspace()`, `get codeRunner()`, `get sandbox()`, `get preview()`), so a
   live value that changes during a session is read per call rather than snapshotted.
5. Add it to the separate ports object inside `builtinProviders()`,
   `src/session/session.ts:314-324`, or the Tools panel will render the new tool as
   unavailable.

The two ports objects are not shared: `builtinProviders()` deliberately omits
`journal`, `approvals`, `mode`, and real `plan` (it stubs `plan` at
`session.ts:320-322`), so a RAG port must be added in both places. `session.test.ts`
exercises this listing path directly (`src/session/session.test.ts:222-225`).

### Provider that needs an injected client

`createCodeToolProvider(runnerSource)` is the precedent for a provider that closes
over a live dependency rather than reading only ports: the factory takes a
`CodeRunnerSource`, and the provider reads it on every availability check and call
(`src/tools/builtin/code.ts:25-55`, constructed at `src/session/session.ts:202`).
An embedder client would follow the same factory shape.

### Approval and mode gating

New builtins are gated by their membership in the mode sets, not by the provider.
`isWithinCeiling` (`src/tools/approval.ts:136-141`) returns true for a tool only when
it is in `modeCeiling` — `READ_ONLY_TOOLS` (approval.ts:31-43) for `read_only` mode,
`EDITING_TOOLS` (approval.ts:45-61) for `editing` — or, in `editing`, when the tool
is user code/network. A builtin absent from both sets would escalate to a per-call
user approval (`resolveApprovalStatus`, approval.ts:150-165, line 160) and would be
invisible in `read_only` mode. Read-only RAG tools therefore have to be added to
`READ_ONLY_TOOLS` (and to `EDITING_TOOLS`, which spreads it, approval.ts:45-46).
`GATED_BUILTINS` (approval.ts:14-29) is the separate list that forces a persisted
default of `ask`; RAG retrieval does not belong in it.

---

## 2. Persistence (Dexie, encryption, settings, binary)

### Schema versions

`VaultDatabase` declares versions in its constructor, `src/vault/db.ts:52-97`. Each
`version(n).stores({...})` restates every table; version 5 (the current head,
`db.ts:87-95`) lists `vault, meta, threads, skills, tools, fs, journals`, and the
newest declaration wins for the whole schema. Record interfaces live beside the class
(`db.ts:5-50`) and each table is declared as a class field with its key type
(`db.ts:53-59`). Adding `documents` and `chunks` is a `version(6).stores({ ... })`
copying the version-5 block plus the two new tables, new `Table<...>` fields, and two
record interfaces. The comment in `ToolRecord`/`SkillRecord` (`db.ts:28-38`) is the
shape to copy: `{ id, blob: EncryptedBlob, updatedAt }` with a secondary index on
`updatedAt`.

### How records are encrypted today

`EncryptedBlob` is `{ iv: Bytes; ciphertext: Bytes }` with
`Bytes = Uint8Array<ArrayBuffer>` (`src/vault/types.ts:1-10`). `encrypt` accepts a
`string | Bytes` plaintext and returns the blob (`src/vault/crypto.ts:86-100`), and
`decryptBytes` returns raw `Uint8Array` while `decrypt` decodes it to a string
(`crypto.ts:112-149`). AAD is domain-separated per record by `aadFor(seed)`, which
encodes `` `${seed}:v1` `` (`src/vault/records.ts:8-10`) — this is the binding used by
`records.test.ts` to prove a blob cannot be reopened under a different seed
(`src/vault/records.test.ts:24-27`).

The critical seam: `encryptRecord` / `decryptRecord` only accept and return
**strings** (`src/vault/records.ts:19-33`). The underlying `encrypt` and
`decryptBytes` already handle bytes, but no records-level helper exposes the binary
path. Encrypted vectors therefore need either a new binary record helper built on
`encrypt`/`decryptBytes`, or the vector stored as a string (for example base64).
Both record helpers snapshot the keyring generation before and after and throw
`VaultLockedError` if the vault locked mid-call
(`records.ts:12-17`, `19-32`); any vector path must preserve that invariant. The
keyring itself is a module singleton with a generation counter
(`src/vault/keyring.ts:1-29`).

### Settings blob and `settings.rag`

Settings are one encrypted blob (`AAD_SETTINGS`) in `db.vault`, decrypted on unlock
(`src/vault/store.ts:165-176`) and re-encrypted whole on every update
(`persistSettings`, `store.ts:188-202`). Reads come from
`useVaultStore((s) => s.settings)`; writes go through `useVaultStore.update(patch)`,
which `deepMerge`s into the live settings then persists (`store.ts:309-320`). The
`rag` block already exists: `RagSettings` declares `embedModel`, `chunkSize`,
`overlap`, `topK`, `thresholds`, `concurrency` (`src/vault/settings.ts:42-49`), it is
part of `Settings` (`settings.ts:107`), and `defaultSettings()` seeds it
(`settings.ts:131-138`). `migrate` merges defaults over any stored object, so a vault
written before a new field existed gets the default (`settings.ts:330-348`), and
`deepMerge` ignores `undefined` and forbidden keys (`settings.ts:296-314`). There is
**no UI for `rag`** anywhere: `embedModel`/`chunkSize`/`overlap`/`concurrency` appear
only in the vault layer and its fixtures; the `topK` in `chat-config.tsx:31` and
`chat/types.ts:7` is a per-thread chat sampling parameter (`config.params.topK`), not
`rag.topK`.

### Binary storage in Dexie

The database already persists non-scalar values: `FsHandleRecord` stores a
`FileSystemDirectoryHandle` directly (`src/vault/db.ts:40-44`), and every encrypted
record stores `Uint8Array` fields inside `EncryptedBlob`. Dexie/IndexedDB store
structured-cloneable binary natively, so a `chunks` table holding an `EncryptedBlob`
whose ciphertext wraps a `Float32Array`/`ArrayBuffer` payload is consistent with the
existing schema. What does not exist today is any indexed binary; vectors would live
inside the encrypted blob, not as a queryable index (there is no `Float32Array`
reference anywhere in `src/vault` outside `crypto.ts`'s `ArrayBufferView` handling at
`crypto.ts:34-44`).

### Write serialisation

`vaultWriteQueue` (`src/vault/write-queue.ts:7-24`) is a simple promise chain used by
`useVaultStore.update` (`store.ts:312-319`) and drained on `lock` (`store.ts:300`).
Threads, skills, and tools each have their own persisted stores rather than routing
through this queue (`src/chat/persistence.ts`, `src/tools/store.ts`), so a document
library would own its own write queue or reuse this one deliberately. `recover()`
clears only the tables it explicitly names (`store.ts:325-336`), so new tables must be
added there and in `vaultInternals.reset` (`store.ts:361-373`).

---

## 3. Embeddings API

The installed `@ai-sdk/openai-compatible` is 3.0.52. Its provider interface declares
`embeddingModel(modelId): EmbeddingModelV4`
(`node_modules/@ai-sdk/openai-compatible/dist/index.d.ts:310-321`, method at line
315), and `createOpenAICompatible(options)` returns that provider
(`.../index.d.ts:384`, options shape at 322-380). The embedding model exposes
`get maxEmbeddingsPerCall(): number` (`index.d.ts:220`), backed by the optional
`maxEmbeddingsPerCall` config field (`index.d.ts:197-205`); the request body also
supports `dimensions` and `user`
(`openaiCompatibleEmbeddingModelOptions`, index.d.ts:191-195).

The installed `ai` is 7.0.105. `ProviderV4.embeddingModel(modelId): EmbeddingModel`
is declared at `node_modules/ai/dist/index.d.ts:240`; `embed` at line 6929 returning
`EmbedResult` (`ai/dist/index.d.ts:6874-6908`, single `embedding: Embedding`) and
`embedMany` at line 7073 returning `EmbedManyResult` (`index.d.ts:7009-7042`). The
vector type is a plain number array: `type Embedding = EmbeddingModelV4Embedding`
(`ai/dist/index.d.ts:10-19`) and `type EmbeddingModelV4Embedding = Array<number>`
(`node_modules/.pnpm/@ai-sdk/provider@4.0.17/node_modules/@ai-sdk/provider/dist/index.d.ts:1685`).
So `embedMany` yields `embeddings: number[][]` in input order
(`ai/dist/index.d.ts:7013-7016`).

Batching is automatic. The `embedMany` docblock states it "automatically splits large
requests into smaller chunks when the model has a limit on either the number of
embeddings or the UTF-8 input bytes that can be processed in a single call", with a
`maxParallelCalls` option defaulting to `Infinity` (`ai/dist/index.d.ts:7044-7073`).
Two consequences for this project: remote batching is already handled by the SDK
against the provider's `maxEmbeddingsPerCall`; and the app's own `rag.concurrency`
(`settings.ts:48`) is separate from that SDK fan-out.

The SDK also exports `cosineSimilarity(vector1: number[], vector2: number[]): number`
(`node_modules/ai/dist/index.d.ts:7930`), which matters because a similarity scan
needs no extra dependency and no hand-rolled dot product.

### `createLLM` and a sibling `createEmbedder`

`createLLM(settings, providerId, modelOverride?)` builds a provider with
`createOpenAICompatible({ baseURL, name, apiKey })` and returns
`compatible.chatModel(modelId)` (`src/ai/llm.ts:8-21`). A sibling `createEmbedder`
would be the same three lines with `.embeddingModel(...)`, and would share
`resolveProvider(settings.providers, providerId)` (`src/ai/providers.ts:47-63`),
which validates the provider and throws `LLMConfigError`. There is no embedding
entry in the client cache today: `src/ai/client-cache.ts` holds only `llmCache` and
`typesafeCache` (`client-cache.ts:9-10`) with generation-based invalidation
(`client-cache.ts:14-45`). An embedder obtained through a cached factory would need a
third cache entry, or it would be rebuilt per call.

---

## 4. PDF parsing with `pdfjs-dist`

`pdfjs-dist` is **not installed** (`package.json:16-71` lists no PDF dependency, and
no `pdfjs` directory exists under `node_modules`). Network was available and the npm
registry reports the current stable version as **6.3.289**
(`npm view pdfjs-dist version`). Registry metadata for 6.3.289: `main` is
`build/pdf.mjs`, no runtime dependencies, and `engines.node` is
`>=22.13.0 || >=24` (build-time only, not a browser constraint). The published
`build/` directory contains `pdf.mjs`, `pdf.min.mjs`, `pdf.worker.mjs`,
`pdf.worker.min.mjs`, `pdf.sandbox.mjs`, plus a `legacy/build/` mirror of each
(confirmed via the unpkg file listing for 6.3.289). The worker URL import pattern the
task assumes — `pdfjs-dist/build/pdf.worker.min.mjs?url` — matches an actually
published file.

For Vite 8, `vite.config.ts:78-80` already sets `worker: { format: "es" }`, so the
worker can be imported either as `import workerUrl from
'pdfjs-dist/build/pdf.worker.min.mjs?url'` and assigned to
`GlobalWorkerOptions.workerSrc`, or instantiated with
`new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type:
'module' })`. Vite emits either as a separate same-origin asset. There is no existing
worker in the app to imitate: the only worker-like runtime is the sandbox, whose
chunks Vite also emits as separate same-origin assets (comment at
`vite.config.ts:22-30`).

### What the current CSP allows and blocks

The CSP is injected by `cspPlugin` in `vite.config.ts:32-63` and applies to the
production build only (`apply: "build"`, line 54; dev is excluded, lines 12-15). The
directives relevant to a PDF worker and wasm:

- `worker-src 'self'` (`vite.config.ts:43`) allows a same-origin emitted worker asset.
  It does **not** include `blob:`, so a worker created from an inlined blob URL would
  be blocked.
- `script-src 'self' blob:` (`vite.config.ts:41`) allows same-origin scripts and app
  blob URLs but contains no `'unsafe-eval'` and no `'wasm-unsafe-eval'`. Any
  main-thread `eval`/`new Function` or `WebAssembly` compile against inline bytes
  would be blocked in production.
- `frame-src 'self' blob:` (line 42), `object-src 'none'` (line 50), and
  `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (line 47).

The decisive nuance is documented in the same file (`vite.config.ts:22-30`): a
same-origin worker does not inherit the document's meta CSP; its policy comes from its
own response headers, and Vite emits worker chunks as separate same-origin assets that
"run without a document CSP and may use eval/WASM". So running pdf.js in its worker
sidesteps the main-thread `script-src` restriction, while parsing on the main thread
would be constrained by the absent `wasm-unsafe-eval` (relevant for JPEG2000/JPX image
decoding; text extraction does not need wasm). The exact wasm need for the target
documents was not verified here.

---

## 5. Vault lock lifecycle

Unlock and lock are methods on `useVaultStore` (`src/vault/store.ts`). `unlock`
(store.ts:263-293) derives the key, installs it in the keyring (line 267), records
`keyring.getGeneration()` into `setGeneration` (line 269) and into the store's
`unlockGeneration` (line 275), decrypts settings, and sets `settings`. `setup`
(store.ts:236-261) does the same for a fresh vault. `lock` (store.ts:295-307) clears
the keyring synchronously first (line 298, with the comment explaining that a queued
write then fails its identity check), invalidates the cached LLM/TypeSafe clients
(line 299), drains the write queue (line 300), and sets `status: 'locked'` and
`settings: null`. `useVaultStore` exposes `status`, `settings`, and
`unlockGeneration` (`store.ts:32-48`), so the generation is a ready epoch for a
"decrypted vectors belong to this unlock" guard.

Existing reaction hooks to the lifecycle, and the patterns to reuse:

- `src/chat/store.ts:169-174` subscribes to the store and, when status leaves
  `'unlocked'`, aborts all runs and clears the chat state. This is the closest thing
  to an app-wide "on lock" hook.
- `src/session/session.ts:184-188` subscribes and updates the sandbox when
  `settings.sandbox` changes; `session.ts:288-296` unsubscribes in `dispose`.
- `SessionProvider` (`src/session/session-provider.tsx:17-48`) creates one session per
  unlock and calls `session.dispose()` plus `useWorkspaceStore.clear()` in its effect
  cleanup (lines 43-47). Because `UnlockedApp` is only mounted while `status ===
  'unlocked'` (`src/App.tsx:59-64`), mount = unlock, unmount = lock, and this is the
  natural place to decrypt vectors into memory and to clear them.
- Idle lock is driven from `UnlockedApp` with `useIdleLock(settings.idleLockMinutes,
  true, () => void lock())` (`src/App.tsx:14-21`); the hook itself only schedules the
  callback (`src/vault/use-idle-lock.ts:5-38`).

There is **no existing RAG-specific hook**: nothing subscribes to unlock to hydrate a
vector index, and no module owns "decrypt on unlock / clear on lock" for documents.
The selection is therefore between a new `useVaultStore.subscribe` (mirroring
`chat/store.ts:169-174`) and the `SessionProvider` mount/dispose lifecycle
(`session-provider.tsx:21-48`).

Loss of the key on lock is enforced broadly: `VaultLockedError` is thrown by
`encryptRecord`/`decryptRecord` (records.ts:21,29), by `update` (store.ts:311,313),
and is treated as a benign race by `main.tsx:19`; chat persistence and the journal
store special-case it (`chat/persistence.ts:130`, `workspace/journal-store.ts:66,121`).

---

## 6. UI seams

### Panel registration

The rail is defined entirely in `src/ui/shell.tsx`. A panel is added in four places:
the `RailPanelId` union (`shell.tsx:47-54`), the `RAIL_IDS` array that both renders
buttons and validates the persisted `sessionStorage` state (`shell.tsx:56-64`,
consumed at 102-106), the `panels: RailPanelDef[]` array that supplies
`{ id, label, icon, render }` (`shell.tsx:315-353`, the Skills entry at 334-339 and
Tools at 340), and the imports at `shell.tsx:33-41`. `PanelFrame` wraps whatever
`render()` returns (`shell.tsx:373-377`). The Skills panel
(`src/ui/panels/skills.tsx:41-340`) and Tools panel (`src/ui/panels/tools.tsx:310`)
are the templates: both are plain function components reading `useSession()`, both use
the shared `primitives.tsx` controls and `PanelSection`, and both re-render off a
registry version (`useRegistryVersion`, `src/ui/use-registry-version.ts`; used at
`skills.tsx:44`). The Tools panel obtains its builtin list from
`session.builtinProviders(config)` at `tools.tsx:330`, so a Library panel would read
its data from a session-exposed API or a new Zustand store in the same style as
`src/session/workspace-state.ts`.

For rendering documents, `kindForExtension`/`kindForTarget`
(`src/ui/file-view/kind.ts:46-74`) map extensions to a `FileKind` and `FilePanel`
switches on it (`src/ui/panels/file-editor.tsx:87-137`); a PDF kind does not exist in
the current union (`kind.ts:3-15`).

### How assistant-ui renders tool calls and results

The runtime is `useExternalStoreRuntime` in `src/chat/use-chat-runtime.ts:143-349`
(created at 331-348) and is provided at `src/ui/shell.tsx:463-465`
(`AssistantRuntimeProvider`). Engine `UIMessage` parts are converted to
`ThreadMessageLike` by `toThreadMessageLike` (`src/chat/convert.ts:154-204`);
tool parts become assistant-ui `tool-call` parts in `convertToolPart`
(convert.ts:48-90), including `result` and `isError` at lines 58-65, and success is
inferred from the `{ ok: false }` envelope at lines 35-37. Source parts are converted
too: `source-url` and `source-document` become assistant-ui `source` parts
(`convert.ts:107-123`).

Rendering happens in the `AssistantMessage` switch at `thread.aui.tsx:697-765`:
`case "tool-call"` returns `part.toolUI ?? <ToolFallbackComponent {...part} />`
(`thread.aui.tsx:737-738`), and `case "data"` returns `part.dataRendererUI`
(line 740). There is **no case for `"source"`**, so the switch falls to `default:
return null` (`thread.aui.tsx:763-764`) and `source-document` parts render nothing
today. `ToolFallback` renders a tool result by formatting it with
`JSON.stringify(value, null, space)` inside a `<pre>`
(`src/components/assistant-ui/elements/tool-fallback.aui.tsx:263-283`), so a
`search_documents` / `get_chunk` result currently renders as raw JSON with no
citation affordance.

No per-tool renderer is registered anywhere in the app: there is no
`makeAssistantToolUI`, `useAssistantToolUI`, `makeAssistantDataUI`, or
`useAssistantTool` call in `src` (grep found none). Those APIs are exported by the
installed `@assistant-ui/react`
(`node_modules/@assistant-ui/react/dist/index.d.ts:75`), and the `part.toolUI` hook
at `thread.aui.tsx:738` is where a registered UI would surface, so custom citation
rendering is an available but currently unused seam. The app does pass a
`ToolFallback` override through `ThreadComponents` (`thread.aui.tsx:672-679`), but it
defaults to the stock fallback (`thread.aui.tsx:674`).

---

## 7. Tests

The runner is Vitest 5 with `globals: true`, `environment: 'node'`, `setupFiles:
['./src/test-setup.ts']`, and `include: ['src/**/*.test.{ts,tsx}']`
(`vitest.config.ts:4-8`). The global setup is a single line,
`import 'fake-indexeddb/auto'` (`src/test-setup.ts:1`), which is what makes the
Dexie-backed vault tests run (`src/vault/store.test.ts` opens `db` directly).

**Mismatch to flag:** the environment is `node`, not `jsdom`. `jsdom` is a
devDependency (`package.json:65`) but is used only through two per-file docblocks,
`// @vitest-environment jsdom` in `src/ui/file-view/artifact-html-transform.test.ts:1`
and `src/ui/file-view/diagram.test.ts:1`. Component tests elsewhere run under `node`
by calling `renderToStaticMarkup` from `react-dom/server` (`src/ui/plan-panel.test.tsx:1`,
`src/ai/secret-field.test.tsx:2`). There is no `@testing-library/react` dependency.
A new provider test should therefore be a plain node-environment test that calls the
tool's `execute` and never mounts a component.

Crypto in tests is the real WebCrypto: `assertSubtle()` reads
`globalThis.crypto.subtle` (`src/vault/crypto.ts:28-32`), and Node supplies it, so
tests derive real keys. `src/vault/records.test.ts:7-12` derives a key with
`iterations: 1000` for speed and installs it in the keyring, then round-trips and
tamper-tests `encryptRecord`/`decryptRecord` (lines 19-27) and asserts
`VaultLockedError` when the keyring clears mid-call (lines 29-51). Fixed ciphertext
fixtures live in `src/vault/test-fixtures.ts:11-35`, including a full `Settings`
object that already carries a `rag` block (`test-fixtures.ts:51-58`).

The representative provider test to imitate is `src/tools/builtin/preview.test.ts`.
It defines the dummy tool-call args `CALL = { toolCallId: 'call-1', messages: [],
context: {} }` (`preview.test.ts:9`), builds a stub `WorkspaceApi`
(`preview.test.ts:17-29`), and drives everything through the real registry with
`registry.registerProvider(createPreviewToolProvider())` then
`registry.buildToolSet(undefined, ports)` (`preview.test.ts:31-35`). It asserts the
contributed names, the availability truth table, the
`ToolRuntimeUnavailableError` path when built without a port (lines 56-67), and the
success/failure envelopes via `resolves.toMatchObject({ ok, code, value })`
(lines 73-83). A RAG provider test should follow this exact shape, supplying a stub
RAG port plus a stub embedder.

---

## Assumption mismatches and constraints discovered

These are places where the brainstorm/plan record in
`plans/260918-1210-rag-typesafe-pipeline/` does **not** match the current code or the
new direction in this task. They are reported, not resolved.

1. **Local vs remote embeddings.** The accepted plan makes local embeddings a
   planned scope item and rejects remote embeddings as an approach: `plan.md:61-63`
   specifies `@huggingface/transformers` (`multilingual-e5-small`, 384 dims), and the
   brainstorm's approach table lists "Server embeddings … violates the client-side
   retrieval requirement" (`reports/brainstorm-260918-1907-...md:86`). The new task
   instead uses the user's OpenAI-compatible provider via `embeddingModel()`. The
   vault's `RagSettings` already reserves `embedModel` (`settings.ts:43`), so the
   field fits, but the surrounding plan text and the "offline retrieval still
   functions" acceptance criterion (`brainstorm:55`, `plan.md:98`) are in tension with
   remote query embedding — with no network, a fresh query cannot be embedded unless
   that vector is cached.
2. **PDF is an explicit non-goal in the old plan.** `plan.md:80-81` lists "PDF or
   DOCX parsing (text and markdown only)" under Non-Goals, and there is no PDF path in
   `src/ui/file-view/kind.ts:3-15`. Adding PDF support reverses that decision.
3. **Plaintext metadata vs encrypted library.** The plan expects "document metadata
   plaintext so the library list renders before unlock" (`plan.md:64-65`), while this
   task specifies a "separate encrypted document library". If the whole record is
   encrypted, the library list cannot render from Dexie before unlock; `VaultLockedError`
   guards every record read (`records.ts:21,29`).
4. **Vector type.** The plan and brainstorm assume `Float32Array` storage
   (`plan.md:91`, `brainstorm:179`), but the SDK's embedding type is `Array<number>`
   (`ai/dist/index.d.ts:10-19`), so a conversion is required before any `Float32Array`
   encryption path.
5. **jsdom-based test setup.** As noted in section 7, the suite runs under `node`;
   jsdom is per-file only.
6. **Tool naming.** The brainstorm's retrieval tool is named `search` and its
   verification tool `verify_citation` (`brainstorm:26-28,126-128`). The existing
   builtin registry already owns `search` as a workspace tool
   (`src/tools/approval.ts:36`), so the new `search_documents` name avoids a
   `ToolNameConflictError` that a bare `search` would raise
   (`registry.ts:70-72`).

## What this research did not cover

- It did not test that pdf.js actually loads and extracts text under the production
  CSP in a browser, nor whether the target PDFs need the wasm/JPX path that the absent
  `wasm-unsafe-eval` (`vite.config.ts:41`) would block on a main-thread parse.
- It did not benchmark remote `embedMany` chunk sizes against any particular
  provider's `maxEmbeddingsPerCall`, since that value is provider- and model-specific
  (default is read from the model, `openai-compatible/index.d.ts:220`).
- It did not inspect `src/tools/store.ts`, `src/chat/persistence.ts`, or the sandbox
  manager beyond their stated roles, because they are not load-bearing for the RAG
  seams above.
- It did not evaluate the Jev/TypeSafe grading layer; that is covered by
  `researcher-01-typesafe-jev.md` in this directory.

### Load-bearing integration facts

- A new provider is registered only at `src/session/session.ts:230-243` **and** added
  to the list at `session.ts:325-338`, because `builtinProviders()` builds its own
  ports object (`session.ts:314-324`) separate from `buildRunStream`'s
  (`engine.ts:329-345`).
- New ports must be added in five coordinated places: `types.ts:219-233`,
  `engine.ts:65-85`, `engine.ts:329-345`, `session.ts:245-263`, and
  `session.ts:314-324`.
- Read-only RAG tools must be added to `READ_ONLY_TOOLS` (`approval.ts:31-43`) or they
  escalate to per-call approval and disappear from `read_only` mode
  (`approval.ts:136-141`, `150-165`).
- `encryptRecord`/`decryptRecord` are string-only (`records.ts:19-33`); binary vector
  encryption must go through `encrypt`/`decryptBytes` (`crypto.ts:86-131`) with the
  keyring-generation guard (`records.ts:12-17`).
- Dexie schema head is `version(5)` (`db.ts:87-95`); `documents` and `chunks` arrive as
  a `version(6)` that restates every table, and both must be added to `recover()`
  (`store.ts:325-336`) and `vaultInternals.reset` (`store.ts:361-373`).
- The SDK embedding vector is `number[]` (`ai/dist/index.d.ts:10-19`,
  `provider/dist/index.d.ts:1685`), `embedMany` auto-batches with `maxParallelCalls`
  (`ai/dist/index.d.ts:7044-7073`), and `cosineSimilarity` is exported from `ai`
  (`ai/dist/index.d.ts:7930`).
- `worker-src 'self'` (`vite.config.ts:43`) permits the Vite-emitted pdf.js worker but
  not a blob worker; the worker escapes the document meta CSP entirely
  (`vite.config.ts:22-30`), while main-thread wasm/eval is blocked by the absence of
  `wasm-unsafe-eval`/`unsafe-eval` (`vite.config.ts:41`).
- The unlock/lock seams are `SessionProvider` mount/dispose
  (`session-provider.tsx:21-48`) and `useVaultStore.subscribe` (as in
  `chat/store.ts:169-174`); `unlockGeneration` (`store.ts:37`) is the epoch to guard
  decrypted vectors.
- Tool results render as raw JSON through `ToolFallback`
  (`thread.aui.tsx:737-738`, `tool-fallback.aui.tsx:263-283`); `source-document` parts
  render nothing (`thread.aui.tsx:763-764`), so citation UI needs either a registered
  `makeAssistantToolUI` (unused today) or a new `"source"` case.
