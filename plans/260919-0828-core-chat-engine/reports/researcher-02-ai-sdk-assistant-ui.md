# Research: AI SDK v7 core engine + assistant-ui 0.15 bridge (UI-agnostic)

- Date: 2026-09-19
- Scope: read-only reconnaissance of installed types + version-matched web docs
- Target: `/Users/ldblckrs/Documents/Personal Project/.temp/sagent-studio`
- Packages verified: `ai@7.0.105`, `@ai-sdk/react@4.0.108`, `@ai-sdk/provider@4.0.17`, `@ai-sdk/provider-utils@5.0.43`, `@ai-sdk/openai-compatible@3.0.52`, `@assistant-ui/react@0.15.20`, `@assistant-ui/core@0.3.19`, `@assistant-ui/store@0.3.13`

## Source key (local `file:line` citations)

| Key | Path |
| --- | --- |
| `A:n` | `node_modules/ai/dist/index.d.ts` |
| `AT:n` | `node_modules/ai/dist/test/index.d.ts` |
| `ATJ:n` | `node_modules/ai/dist/test/index.js` |
| `P:n` | `node_modules/.pnpm/@ai-sdk+provider@4.0.17/node_modules/@ai-sdk/provider/dist/index.d.ts` |
| `PU:n` | `node_modules/.pnpm/@ai-sdk+provider-utils@5.0.43_zod@4.6.5/node_modules/@ai-sdk/provider-utils/dist/index.d.ts` |
| `R:n` | `node_modules/@ai-sdk/react/dist/index.d.ts` |
| `AR:n` | `node_modules/@assistant-ui/react/dist/index.d.ts` |
| `core/<rel>:n` | `node_modules/.pnpm/@assistant-ui+core@0.3.19_.../node_modules/@assistant-ui/core/dist/<rel>` |
| `store/<rel>:n` | `node_modules/.pnpm/@assistant-ui+store@0.3.13_.../node_modules/@assistant-ui/store/dist/<rel>` |

`ai@7` = AI SDK v7 docs (`ai-sdk.dev/docs`, `v7 (Latest)`); `@assistant-ui/react@0.15` docs agree with the installed types (e.g. `useAui`, `AuiConfig`). Web claims below that are not also present in the installed declarations are marked **UNVERIFIED**.

---

## Q1 — `ChatTransport<UI_MESSAGE>`, `sendMessages` return, stream helpers, `DirectChatTransport`

### Exact interface

`A:5426-5492` declares `interface ChatTransport<UI_MESSAGE extends UIMessage>` with exactly two members:

```ts
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  sendMessages: (options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;
    messages: UI_MESSAGE[];
    abortSignal: AbortSignal | undefined;
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk>>;

  reconnectToStream: (options: {
    chatId: string;
    abortSignal?: AbortSignal;
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk> | null>;
}
```

- `sendMessages` is **required**; it must return `Promise<ReadableStream<UIMessageChunk>>` — a plain `ReadableStream`, not the `AsyncIterableStream` alias (`A:5465`).
- `reconnectToStream` is **required in the type** (not optional `?`) and returns `null` when there is no resumable stream (`A:5486-5491`). `DirectChatTransport` implements it as an always-`null` no-op (`A:5894`).
- `ChatRequestOptions` = `{ headers?, body?, metadata? }` (`A:5505-5515`).
- `UIMessageChunk` is a discriminated union of `text-*`, `reasoning-*`, `tool-input-*`, `tool-output-*`, `tool-approval-*`, `source-*`, `file`, `start`/`finish`/`abort`, `start-step`/`finish-step`/`reset-step`, `message-metadata` (`A:2345-2493`).

### How the stream helpers relate

- `streamText(...).stream` is `AsyncIterableStream<TextStreamPart<TOOLS>>` (`A:2815`) — **not** a UI chunk stream.
- `toUIMessageStream({ stream, tools?, ... })` converts `ReadableStream<TextStreamPart<TOOLS>>` → `ReadableStream<InferUIMessageChunk<UI_MESSAGE>>` (`A:6184-6188`). This is the recommended, non-deprecated path.
- `createUIMessageStream({ execute })` gives an imperative `writer` and returns `ReadableStream<UIMessageChunk>` (`A:6070-6097`); use when composing chunks manually. `writer.write(part)` / `writer.merge(stream)` (`A:6036-6053`).
- `createUIMessageStreamResponse({ stream })` → HTTP `Response` encoded as SSE (`A:6111-6113`). HTTP-only; not needed in-browser.
- Deprecated methods on `StreamTextResult`: `.toUIMessageStream()` (`A:2862`), `.pipeUIMessageStreamToResponse()` (`A:2870`), `.toUIMessageStreamResponse()` (`A:2893`) — all say "use the standalone `toUIMessageStream` / `createUIMessageStreamResponse` with `result.stream` instead". So `streamText().toUIMessageStreamResponse()` is the legacy equivalent of `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`.

### In-browser transport pattern: `DirectChatTransport`

Yes — documented for in-process use with no HTTP server (`ai-sdk.dev/docs/ai-sdk-ui/transport`, "Direct Agent Transport": "communicate directly with an Agent without going through HTTP … single-process applications").

```ts
// A:5854-5863
type DirectChatTransportOptions<...> = {
  agent: Agent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT>;
  options?: CALL_OPTIONS;
} & Omit<UIMessageStreamOptions<UI_MESSAGE>, 'onFinish'>;

// A:5882-5886
declare class DirectChatTransport<...> implements ChatTransport<UI_MESSAGE> {
  constructor({ agent, options, ...uiMessageStreamOptions }: DirectChatTransportOptions<...>);
  sendMessages(...): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(...): Promise<ReadableStream<UIMessageChunk> | null>; // always null
}
```

- Constructor: `new DirectChatTransport({ agent: myAgent })`; extra `UIMessageStreamOptions` (e.g. `sendReasoning`, `sendSources`, `originalMessages`, `onEnd`) may be spread as the rest (`A:5886`).
- Accepts a `ToolLoopAgent`: the option is typed `Agent<...>` (`A:5858`), and `ToolLoopAgent` declares `implements Agent<...>` (`A:5299`); the `Agent` interface is `version`/`id`/`tools`/`generate`/`stream` (`A:4745-4767`).
- Documented behavior: `DirectChatTransport` validates UI messages, converts via `convertToModelMessages`, calls `agent.stream()`, and returns `toUIMessageStream()` output (`ai-sdk.dev/docs/ai-sdk-ui/transport`).
- `@ai-sdk/react`'s `useChat` consumes it directly: `useChat({ transport: new DirectChatTransport({ agent }) })` (`R:115-132`, `ChatInit.transport` at `A:5607`).

---

## Q2 — tool loop: `stopWhen` + `stepCountIs`, tool declarations, `prepareStep`, `onStepFinish`

### `stopWhen` / `stepCountIs`

- `stepCountIs` is an **alias of `isStepCount`** (`A:10025` export list: `isStepCount as stepCountIs`). Declaration: `declare function isStepCount(stepCount: number): StopCondition<any, any>` (`A:1804`).
- `StopCondition<TOOLS>` = `(options: { steps: StepResult<TOOLS>[] }) => boolean | PromiseLike<boolean>` (`A:1795-1797`).
- `stopWhen?: Arrayable<StopCondition<TOOLS>>`; an array stops when **any** condition is true (`A:3504-3510`).
- Defaults differ: `streamText` defaults to `isStepCount(1)` (`A:3508`); `ToolLoopAgent` defaults to `isStepCount(20)` (`A:5105`). Other built-ins: `isLoopFinished()` (`A:1811`), `hasToolCall(...names)` (`A:1818`).

### Declaring tools

`tool`, `dynamicTool`, `jsonSchema`, and the `ToolSet`/`Tool`/`ToolExecuteFunction` types are re-exported from `ai` (`A:7`), physically defined in `@ai-sdk/provider-utils`:

```ts
// PU:2165-2171 — static tool with execute
declare function tool<INPUT, OUTPUT, CONTEXT extends Context>(
  tool: Tool<INPUT, OUTPUT, CONTEXT> & { execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT> }
): ExecutableTool<Tool<INPUT, OUTPUT, CONTEXT>>;

// PU:2175 — runtime (MCP-like) tool; discriminated by type: 'dynamic'
declare function dynamicTool(tool: Omit<DynamicTool<unknown, unknown, Context>, 'type'>): DynamicTool<...>;

// PU:849-851 — schema from raw JSON Schema (no zod needed)
declare function jsonSchema<OBJECT = unknown>(
  jsonSchema: JSONSchema7 | PromiseLike<JSONSchema7> | (() => JSONSchema7 | PromiseLike<JSONSchema7>),
  { validate }?: { validate?: (value: unknown) => ValidationResult<OBJECT> | PromiseLike<ValidationResult<OBJECT>> }
): Schema<OBJECT>;
```

Important v7 field name: **`inputSchema`** (not `parameters`) — `BaseTool.inputSchema: FlexibleSchema<INPUT>` (`PU:1983`); `outputSchema` is optional when `execute` is present (`PU:1919-1942`). `execute` receives `(input, options)` where `options` is `ToolExecutionOptions` (`toolCallId`, `messages`, `abortSignal?`, `context`, `experimental_sandbox?`; `PU:1851-1885`). Optional `toModelOutput` maps the result to model output (`PU:2024-2037`). `ToolSet = Record<string, Tool<...> & Pick<Tool, 'execute' | 'onInputAvailable' | ... >>` (`PU:2712`). `dynamicTool` produces `type: 'dynamic'` parts, surfaced as `dynamic-tool` in UI (`A:2142`).

### Per-step overrides: `prepareStep`

Signature `A:1664-1710`; result `A:1719-1783`:

```ts
type PrepareStepResult<TOOLS, RUNTIME_CONTEXT> = ({
  model?: LanguageModel;                 // swap model for this step
  toolChoice?: ToolChoice<TOOLS>;
  activeTools?: ActiveTools<TOOLS>;      // restrict which tools are enabled this step
  toolOrder?: ToolOrder<TOOLS>;
  instructions?: Instructions;           // per-step system prompt override (carries forward)
  system?: Instructions;                 // @deprecated alias
  messages?: ModelMessage[];             // full message override (carries forward)
  toolsContext?: InferToolSetContext<TOOLS>;
  runtimeContext?: RUNTIME_CONTEXT;
  experimental_sandbox?: Experimental_SandboxSession;
  providerOptions?: ProviderOptions;
} & LanguageModelCallOptions) | undefined;
```

**Nuance:** there is **no `tools` replacement** in `PrepareStepResult`. "Switch tools per step" is done with `activeTools` (subset of the outer `tools`). `model` swapping per step is first-class. Non-undefined overrides carry forward to later steps (`A:1695-1697`, `A:1720-1741`). `runtimeContext` and `toolsContext` may be mutated between steps via `prepareStep` (`A:3532-3534`, `PU:1869-1874`).

### `onStepFinish` / `onStepEnd`

- `onStepFinish` is a **deprecated alias** of `onStepEnd` on `streamText` (`A:3672-3678`), `generateText` (`A:5028-5034`), and `ToolLoopAgentSettings` (`A:5217-5223`).
- Event type = the full `StepResult<TOOLS, RUNTIME_CONTEXT>` (`A:4012`), which exposes:
  - `toolCalls: TypedToolCall<TOOLS>[]`, `staticToolCalls`, `dynamicToolCalls` (`A:1466-1474`)
  - `toolResults: TypedToolResult<TOOLS>[]`, `staticToolResults`, `dynamicToolResults` (`A:1478-1486`)
  - `text`, `reasoning`, `reasoningText`, `content`, `finishReason`, `usage`, `warnings`, `stepNumber`, `model` (`A:1417-1520`).
- Related hooks: `onToolExecutionStart` / `onToolExecutionEnd` (`A:5209-5213`), `onStepStart` (`A:5190`), `onEnd` (`A:5227`). `onStepEnd` on `createUIMessageStream` is a **UI-message** callback (`UIMessageStreamOnStepEndCallback`, `A:5374-5389`), distinct from `streamText`'s step callback.

Minimal multi-step shape (project uses `createLLM(...)` → `LanguageModel`, `src/ai/llm.ts:8-21`):

```ts
import { streamText, stepCountIs, tool, jsonSchema } from 'ai';
import type { LanguageModel } from 'ai';

const result = streamText({
  model: createLLM(settings, providerId, modelOverride) as LanguageModel,
  system: composedSystemPrompt,             // per-thread system instruction
  messages: await convertToModelMessages(uiMessages),
  tools: {
    read_file: tool({
      description: 'Read a workspace file',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path }) => readFile(path),
    }),
  },
  stopWhen: stepCountIs(5),                  // hard step cap
  prepareStep: ({ stepNumber, activeTools }) =>
    stepNumber === 0 ? { activeTools: ['read_file'] } : { temperature: 0.2 },
  onStepEnd: (step) => {
    // step.toolCalls, step.toolResults are available per step
    persistStep(step.stepNumber, step.toolCalls, step.toolResults);
  },
});
```

`ToolLoopAgent` is the alternative when you want the loop encapsulated and to feed `DirectChatTransport` (`A:5299-5326`, `ToolLoopAgentSettings` `A:5073-5286`).

---

## Q3 — `UIMessage` shape, `convertToModelMessages`, persistence/rehydration, JSON-safety

### Shape (`A:1845-2010`)

```ts
interface UIMessage<METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes, TOOLS extends UITools = UITools> {
  id: string;                                  // A:1849
  role: 'system' | 'user' | 'assistant';       // A:1853
  metadata?: METADATA;                         // A:1857
  parts: Array<UIMessagePart<DATA_PARTS, TOOLS>>; // A:1868
}
```

`UIMessagePart` is a union (`A:1870`): `TextUIPart` (`A:1874-1888`), `ReasoningUIPart` (`A:1906-1924`, has optional `id`), `ToolUIPart<TOOLS>` (`A:2137-2141`, type `` `tool-${NAME}` ``), `DynamicToolUIPart` (`A:2142-2250`, `type: 'dynamic-tool'`), `SourceUrl`/`SourceDocument`, `FileUIPart` (`A:1949-1983`), `ReasoningFileUIPart`, `DataUIPart` (`A:2011-2017`), `StepStartUIPart` (`A:2008-2010`), `CustomContentUIPart`.

Tool parts carry a state machine in `UIToolInvocation` (`A:2028-2136`): `input-streaming` → `input-available` → (`approval-requested` / `approval-responded`) → `output-available` | `output-error` | `output-denied`. `toolCallId`, `input`, `output`, `errorText`, `approval` live on the part itself. This maps 1:1 to the `tool-input-*` / `tool-output-*` / `tool-approval-*` chunk types (`A:2378-2446`).

### (a) UI → model messages

```ts
// A:5736-5740
declare function convertToModelMessages<UI_MESSAGE extends UIMessage>(
  messages: Array<Omit<UI_MESSAGE, 'id'>>,
  options?: {
    tools?: ToolSet;                                   // pass the SAME tools you pass to streamText
    ignoreIncompleteToolCalls?: boolean;
    convertDataPart?: (part: DataUIPart<...>) => TextPart | FilePart | undefined;
  }
): Promise<ModelMessage[]>;                            // async in v7
```

It is **async** (must `await`) and takes `messages` with `id` omitted. The `tools` option matters: `toModelOutput` is invoked inside conversion, so the same `ToolSet` must be passed to both `convertToModelMessages` and `streamText` (`PU:2022-2023`).

Validation/rehydration helpers:
- `validateUIMessages(options): Promise<UIMessage[]>` (`A:6025`; options `A:5999-6016`).
- `safeValidateUIMessages(options): Promise<{ success: true; data } | { success: false; error }>` (`A:6017`).
- `uiMessageChunkSchema` (`A:2336`), `readUIMessageStream({ message?, stream })` to fold a chunk stream back into messages (`A:6152-6157`).

### (b) Persist / rehydrate

`UIMessage` is a plain object graph, so `JSON.stringify` / `JSON.parse` round-trips it. Recommended: an envelope, e.g. `{ version: 1, messages: UIMessage[] }`.

**Is it JSON-serializable with no class instances? Yes.**
- `id` is `string`, `role` a string literal, `metadata` is user-supplied JSON.
- Every part is a plain object; text/reasoning hold strings; `FileUIPart` holds a `url` string (data URL or hosted URL) plus `mediaType`/`filename`, and `providerReference` is a string map — never a `File` or `Blob` (`A:1949-1983`).
- Provider metadata is `ProviderMetadata` (JSON) (`A:1887` etc.); `JSONValue` is enforced across provider-level payloads.
- Caveats: do **not** attach a `File` to a part; convert via `convertFileListToFileUIParts` (`A:5723`). Persisting in-flight `state: 'streaming'` parts is your call — on rehydrate they should be treated as `done` or dropped. Dates, if you add them to `metadata`, become strings on round-trip, so store ISO strings deliberately.

Rehydration paths: pass the array back as `useChat({ messages })` / `ChatInit.messages` (`A:5601`), or into your external store. Supplying `originalMessages` to `toUIMessageStream`/`createUIMessageStream` switches to persistence mode and assigns a response message ID (`A:2584-2596`, `A:6076-6080`).

---

## Q4 — `ai/test` exports and a deterministic Vitest snippet

### Exact exports

`AT:302` exports: `MockLanguageModelV3`, `MockLanguageModelV4`, `MockProviderV3`, `MockProviderV4`, `MockEmbeddingModelV3/V4`, `MockImageModelV3/V4`, `MockSpeechModelV3/V4`, `MockTranscriptionModelV3/V4`, `MockRerankingModelV3/V4`, `MockVideoModelV3/V4`, `Experimental_EvaluationMockModelV4`, `Experimental_MockSpeechTranslationModelV4`, `mockValues`, `simulateReadableStream`. `AT:1` additionally re-exports `convertArrayToAsyncIterable`, `convertArrayToReadableStream`, `convertReadableStreamToArray`, `mockId` from `@ai-sdk/provider-utils/test`.

- `MockLanguageModelV4` constructor (`AT:120-137`): `{ provider?, modelId?, supportedUrls?, doGenerate?, doStream? }`. Each of `doGenerate`/`doStream` accepts a function **or a single result or an array of results**.
- Array semantics (`ATJ:209-218`): `doStream[this.doStreamCalls.length - 1]` — i.e. the Nth call gets `doStream[N-1]`. **Gotcha:** if a call has no matching array entry it resolves to `undefined`, which throws downstream. Provide exactly as many results as loop iterations.
- `mockValues<T>(...values: T[]): () => T` (`AT:295`) — returns the last value when exhausted.
- `simulateReadableStream` is the **deprecated alias** in `ai/test` (`AT:298-300`); the supported declaration is in `ai` main: `simulateReadableStream({ chunks, initialDelayInMs?, chunkDelayInMs? }): ReadableStream<T>` (`A:7988-7995`). Docs: use `import { simulateReadableStream } from 'ai'`.

### Chunk shape used by the mock

`LanguageModelV4StreamPart` (`P:3115-3174`): `text-start|delta|end`, `reasoning-start|delta|end`, `tool-input-start|delta|end`, plus the content parts `LanguageModelV4ToolCall` / `ToolResult` / `File` / `Source`, `stream-start`, `response-metadata`, `finish`, `raw`, `error`.

`LanguageModelV4ToolCall` (`P:517-546`): `{ type: 'tool-call', toolCallId, toolName, input: string /* JSON string */, providerExecuted?, dynamic?, providerMetadata? }`.

`finishReason` is an object: `{ unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other', raw: string | undefined }` (`P:603-636`). `usage` requires full nesting: `inputTokens.{total,noCache,cacheRead,cacheWrite}` and `outputTokens.{total,text,reasoning}` (`P:641-685`). This matches the v7 testing docs exactly.

### Minimal working Vitest test (node env)

Repo config: `environment: 'node'`, `globals: true`, setup `src/test-setup.ts` (`vitest.config.ts:3-9`). No DOM/network is used; Web Streams are available in Node ≥ 18, which is what `simulateReadableStream` returns. `jsonSchema` avoids adding `zod` as a direct dependency (project `package.json` has no `zod`).

```ts
// src/ai/engine.test.ts
import { describe, expect, it } from 'vitest';
import { streamText, stepCountIs, tool, jsonSchema, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

it('emits deterministic text and one tool call across two steps', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      // Step 1: one tool call
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'add',
              input: '{"a":1,"b":2}',
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ],
        }),
      },
      // Step 2: final text
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'The sum is 3.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }),
      },
    ],
  });

  let received: { a: number; b: number } | undefined;

  const result = streamText({
    model,
    prompt: 'Add 1 and 2.',
    tools: {
      add: tool({
        description: 'Add two numbers.',
        inputSchema: jsonSchema<{ a: number; b: number }>({
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
          additionalProperties: false,
        }),
        execute: async (input) => {
          received = input;
          return input.a + input.b;
        },
      }),
    },
    stopWhen: stepCountIs(2),
  });

  const text = await result.text;          // resolves after the loop finishes

  expect(text).toBe('The sum is 3.');
  expect(received).toEqual({ a: 1, b: 2 });
  expect(model.doStreamCalls).toHaveLength(2);
});
```

Notes:
- Streaming the tool arguments as `tool-input-start`/`tool-input-delta`/`tool-input-end` is optional; the minimal deterministic form is a single `tool-call` part (`P:3142-3158`, `P:517-546`). **UNVERIFIED**: whether emitting both the `tool-input-*` sequence *and* a `tool-call` part is deduplicated — stick to one form.
- `result.text` is the final-step text (`A:2659`); to assert intermediate tool calls use `await result.steps` (`A:2765`) or capture `onStepEnd` (`A:3672`). `model.doStreamCalls` records the raw `LanguageModelV4CallOptions` per call, useful to assert `prepareStep` model switches.

---

## Q5 — assistant-ui 0.15: who owns history; which runtime accepts an app-owned array

### `useChatRuntime` is **not** in `@assistant-ui/react@0.15.20`

Verified by scanning the installed package: `grep -rn "useChatRuntime" @assistant-ui/react/dist` returns nothing. The runtime-creation hooks actually exported by `@assistant-ui/react` are `useLocalRuntime` (`AR:24`), `useExternalStoreRuntime` (`AR:21`), `useRemoteThreadListRuntime`, `useCloudThreadListRuntime`, and `useAssistantTransportRuntime` (`AR:81` export list). `useAui`/`useAuiState` are re-exported from `@assistant-ui/store` (`AR:76`).

`useChatRuntime` ships in **`@assistant-ui/ai-sdk`**, which is **not installed** in this project (`node_modules/@assistant-ui/` contains only `react` and `react-markdown`). Docs (`assistant-ui.com/docs/runtimes/ai-sdk/overview`) confirm the v7 package is `@assistant-ui/ai-sdk`, providing `useChatRuntime` (recommended) and `useAISDKRuntime` (lower level, wraps an existing `useChat` instance). An older-doc reference to `useChatRuntime` also appears in a doc comment at `core/dist/store/scopes/message.d.ts:21`, importing from `@assistant-ui/ai-sdk`.

### Comparison

| Runtime | Who owns history | Adapter contract | Fit for app-owned undo/rerun/edit |
| --- | --- | --- | --- |
| `useLocalRuntime(chatModel, opts?)` (`core/dist/react/runtimes/useLocalRuntime.d.ts:41`) | **The runtime** (in-memory thread state, branches, editing) | `ChatModelAdapter = { run(options: ChatModelRunOptions): ChatModelRunResult \| AsyncGenerator<ChatModelRunResult> }` (`core/dist/runtime/utils/chat-model-adapter.d.ts:34-36`) | No. You supply a single `run`; the runtime owns the message array. Good for a simple engine but not for "my store drives the UI". |
| `useExternalStoreRuntime(store)` (`core/dist/react/runtimes/useExternalStoreRuntime.d.ts:4`) | **The app** (`messages` prop + `setMessages`) | `ExternalStoreAdapter<T>` (`core/dist/runtimes/external-store/external-store-adapter.d.ts:211`) | **Yes.** This is the adapter to feed your own array/Zustand store. |
| `useChatRuntime` / `useAISDKRuntime` (`@assistant-ui/ai-sdk`, **not installed**) | The AI SDK `useChat` instance | Wraps `useChat`; layered on `ExternalStoreRuntime` per docs | Yes, but requires an extra dependency. `useChat` accepts a custom `transport` (`A:5607`), including `DirectChatTransport`. |
| `useAssistantTransportRuntime({ api, ... })` (`core/.../assistant-transport/useAssistantTransportRuntime.d.ts:11`) | Server, via command/state protocol | `AssistantTransportOptions.api: string` required (`.../assistant-transport/types.d.ts`) | No — HTTP endpoint protocol; wrong shape for a browser-only SPA. |

### Is a custom `ChatTransport` sufficient?

**No, not for assistant-ui.** A `ChatTransport` is an AI SDK-level contract consumed by `useChat` (`A:5607`, `R:115-132`). assistant-ui's primitives read a `AssistantRuntime`/store, not a transport. So you need one of:

1. `useAISDKRuntime(useChat({ transport: new DirectChatTransport({ agent }) }))` — cleanest if you add `@assistant-ui/ai-sdk`. The transport carries streaming; assistant-ui adapts the `useChat` messages. Docs confirm `@assistant-ui/ai-sdk` "is layered on `ExternalStoreRuntime`".
2. **`useExternalStoreRuntime`** (already installed) — bridge your core engine's message array to the UI yourself, implementing `onNew`/`onEdit`/`onReload`/`onCancel`/`setMessages`. This is the only installed path and the best fit for custom undo/rerun/edit.
3. A custom `AssistantRuntime` implementation (`AssistantRuntime = { threads, thread, registerModelContextProvider }`, `core/dist/runtime/api/assistant-runtime.d.ts:7-22`) — maximum control, most work, not recommended.

### Adapter shape for the app-owned path (`ExternalStoreAdapter`)

`core/dist/runtimes/external-store/external-store-adapter.d.ts`:

- `messages?: readonly T[]` (`:81`), `setMessages?: (messages: readonly T[]) => void` (`:102`) — required for branch switching.
- `onNew: (message: AppendMessage) => Promise<void>` (`:124`) — **required**.
- `onEdit?: (message: AppendMessage) => Promise<void>` (`:127`) — enables the edit button.
- `onReload?: (parentId: string | null, config: StartRunConfig) => Promise<void>` (`:129`) — enables regenerate.
- `onCancel?: () => Promise<void>` (`:131`).
- `onResume?: (config: ResumeRunConfig) => Promise<void>` (`:130`).
- `onDelete?: (messageId: string) => Promise<void> | void` (`:128`).
- `onAddToolResult?: (options: AddToolResultOptions) => ...` (`:141`), `onRespondToToolApproval?` (`:146`).
- `messageRepository?: ExportedMessageRepository` (`:82`) for a full branch tree; `unstable_messageRepositoryInstance?: MessageRepository` (`:91`) for host-owned branch isolation.
- `convertMessage?: (message: T, idx: number) => ThreadMessageLike` (`:147`, and required when `T !== ThreadMessage` via `ExternalStoreMessageConverterAdapter`, `:51-53`).
- `isRunning?`, `isDisabled?`, `isSendDisabled?`, `isLoading?`, `suggestions?`, `extras?`, `state?`, `queue?`, `adapters?`.

Docs `assistant-ui.com/docs/runtimes/custom/external-store` give the handler→feature matrix: `onEdit`→edit button, `onReload`→regenerate, `onCancel`→cancel, `setMessages`→branch switching. So an app-owned array with custom undo/rerun/edit is exactly what this adapter is for.

### Recommended bridge for this ticket

Build the UI-agnostic engine to own a `UIMessage[]` (or a `ThreadMessageLike`-compatible array) plus operations `send`, `edit`, `rerun`, `undo`, `cancel`. Expose them to a future `useExternalStoreRuntime` adapter by implementing:

- `onNew` → engine.sendMessage (convert `AppendMessage` → `UIMessage`)
- `onEdit` → engine.editMessage at `message.parentId`
- `onReload` → engine.rerun(parentId)
- `onCancel` → engine.abort (via the `AbortSignal` threaded into `sendMessages`)
- `setMessages`/`onDelete` → engine store updates
- `convertMessage` → map your message type to `ThreadMessageLike`

Then a `DirectChatTransport` or custom `ChatTransport` returns `toUIMessageStream({ stream: streamTextResult.stream })` for streaming. This keeps the engine UI-agnostic and lets either `useExternalStoreRuntime` (installed, no new dep) or `useAISDKRuntime` (if `@assistant-ui/ai-sdk` is added later) drive the UI without a rewrite.

---

## Q6 — edit/regenerate/undo primitives a future UI ticket would call

The 0.15 API surface is `useAui()` → `AssistantClient` (`store/dist/useAui.d.ts:64`) and `useAuiState(selector)` (`store/dist/useAuiState.d.ts:38`). Scope methods are on the client (properties, not calls — v0.15 migration guide). There is **no** runtime method literally named `message.edit`; editing is `message.composer().beginEdit()`.

Addressing a message: from outside a message render context use `aui.thread.message({ id })` (`core/dist/store/scopes/thread.d.ts:131-135`); inside a rendered message scope, `aui.message` resolves the current message (the v0.15 migration guide maps `useMessageRuntime()` → `useAui().message`).

### Thread scope (`core/dist/store/scopes/thread.d.ts:60-145`)

```ts
aui.thread.append(message: CreateAppendMessage): void;       // :97
aui.thread.startRun(config: CreateStartRunConfig): void;     // :103
aui.thread.resumeRun(config: CreateResumeRunConfig): void;   // :108
aui.thread.cancelRun(): void;                                // :109
aui.thread.deleteMessage(messageId: string): void | Promise<void>; // :98
aui.thread.reset(initialMessages?): void;                    // :129
aui.thread.import(repository) / .export(): ExportedMessageRepository; // :123-124
aui.thread.message({ id } | { index }): MessageMethods;      // :131-135
```

`CreateAppendMessage` = `string | { parentId?, sourceId?, role?, content, attachments?, metadata?, createdAt?, runConfig?, startRun? }` (`core/dist/runtime/api/thread-runtime.d.ts:30-44`). Passing `startRun: true` (or using `startRun`) begins a generation.

### Message scope (`core/dist/store/scopes/message.d.ts:37-72`)

```ts
aui.thread.message({ id }).delete(): void | Promise<void>;          // :43
aui.thread.message({ id }).reload(config?): void;                   // :44 — REGENERATE this assistant message
aui.thread.message({ id }).switchToBranch({ position | branchId });  // :54-57
aui.thread.message({ id }).composer(): ComposerMethods;             // :42 — edit composer
aui.thread.message({ id }).submitFeedback({ type });                // :51
```

### Composer scope (`core/dist/store/scopes/composer.d.ts:59-97`)

```ts
aui.thread.message({ id }).composer().beginEdit(): void;  // :74 — enter edit mode for that message
aui.thread.message({ id }).composer().setText(text): void; // :61
aui.thread.message({ id }).composer().setRole(role): void; // :62
aui.thread.message({ id }).composer().send(): void;        // :72 — SAVE the edit (re-runs downstream)
aui.thread.message({ id }).composer().cancel(): void;      // :73 — exit edit without saving
```

Deterministic edit recipe for a future UI: `beginEdit()` → `setText(newText)` → `send()`. This works for **both** user and assistant messages — `beginEdit` lives on the runtime class `EditComposerRuntime` (`core/dist/runtime/api/composer-runtime.d.ts:186-196`, `beginEdit()` at `:192`), and `MessageRuntime.composer: EditComposerRuntime` is exposed for every message (`core/dist/runtime/api/message-runtime.d.ts:28`).

### Runtime-class equivalents (non-store path)

`ThreadRuntime.append/startRun/cancelRun/reset/import/export/getMessageById` (`core/dist/runtime/api/thread-runtime.d.ts:107-193`); `MessageRuntime.delete/reload/switchToBranch` (`core/dist/runtime/api/message-runtime.d.ts:26-54`); internal core binding exposes `beginEdit(messageId)` (`thread-runtime.d.ts:254`).

### Events to wire undo/rerun UI state

Via `useAuiEvent` (`AR:81`): `thread.runStart` / `thread.runEnd` / `thread.cancelRun` (`thread.d.ts:164-178`), `message.reload` (`message.d.ts:85-88`), `message.branchSwitched` (`message.d.ts:89-93`), `composer.send` (`composer.d.ts:107-113`).

### Undo

**No `undo` primitive exists** in the installed `@assistant-ui/react` / `@assistant-ui/core` / `@assistant-ui/store` types (a repo-wide grep for `undo` returns nothing in those packages). Undo must be app-level: `aui.thread.deleteMessage(id)` / `aui.thread.message({ id }).delete()`, or (better, since you own the engine) keep a snapshot stack in your own store and call `setMessages` on the `ExternalStoreAdapter`. Re-running after undo is `message.reload()` / `onReload`.

---

## Architectural fit and recommendation (ranked)

**1. Build the engine around AI SDK primitives, not around assistant-ui (recommended).** `streamText` with `convertToModelMessages` + a capped `stopWhen: stepCountIs(n)` + `onStepEnd` for persistence/step tracing is the whole core. Stream out through `toUIMessageStream({ stream: result.stream })`, which is a plain `ReadableStream<UIMessageChunk>` you can hand to *any* consumer (a `ChatTransport`, assistant-ui, tests). Skills become system-prompt composition: `UIMessage` carries no system part by convention (`A:1861-1862`), so inject markdown bundles into `system` / `instructions`. `uploadSkill` (`A:10019-10023`) is for provider-side skill upload (`SkillsV4`), a different mechanism — do not confuse the two.

**2. Bridge to assistant-ui with `useExternalStoreRuntime` (already installed), not with a transport.** Adapter functions map 1:1 to engine operations (`onNew`/`onEdit`/`onReload`/`onCancel`/`setMessages`); `useAuiState`/`useAui` then give the UI edit (`beginEdit`/`setText`/`send`), regenerate (`reload`), and message deletion for free.

**3. Optional later: add `@assistant-ui/ai-sdk` and switch to `useAISDKRuntime(useChat({ transport }))`.** This gives you `DirectChatTransport` + `useChat` semantics plus more adapters, at the cost of one dependency and a second message-state owner. Trade-off: less control over the "app-owned array" invariant that undo/rerun/edit requirements imply — which is why option 2 is ranked higher for this ticket.

Adoption risk notes: `ai@7` is a **major** with several deprecations already in place (`.toUIMessageStream*` methods, `onStepFinish`, `experimental_*` aliases) — code against the standalone helpers and new names now. `@assistant-ui` 0.15 moved to the `useAui`/`AuiConfig` store API and is mid-migration (v0.15 migration doc, many `unstable_*` surfaces) — expect churn in adapter option names. `DirectChatTransport` is solid for browser-only but `reconnectToStream` is a guaranteed `null` (`A:5894`), so "resume after reload" needs app-level persistence, not transport reconnection.

**Limitations of this research:** runtime behavior (as opposed to types/docs) was not executed; the `ExternalStoreRuntime` → engine wiring is a recommendation, not a compiled proof. The exact redundancy behavior of emitting both `tool-input-*` chunks and a `tool-call` part in the same mocked stream is **UNVERIFIED**. `@assistant-ui/ai-sdk` and `@assistant-ui/react-ai-sdk` are not installed, so their option types are derived from docs only (**UNVERIFIED** against local declarations). AI SDK web docs are v7 and matched the installed types on every claim used here, but docs and package can still drift within v7.x.
