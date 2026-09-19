# Research: Human-in-the-loop approval gates + uniform tool-result contract

**Date:** 2026-09-20
**Scope:** AI SDK v7 approval APIs, tool result/error contract, assistant-ui 0.15.x tool primitives, openai-compatible constraints.
**Method:** primary source = installed package source in `node_modules` (exact, version-pinned), cross-checked against shipped `.mdx` docs and the live official docs sites (3 independent references per key claim).

Installed versions (verified from `node_modules/<pkg>/package.json`):

| Package | Installed | Pinned in `package.json` |
|---|---|---|
| `ai` | 7.0.105 | `^7.0.105` |
| `@ai-sdk/react` | 4.0.108 | `^4.0.108` |
| `@assistant-ui/react` | 0.15.20 | `^0.15.20` |
| `@assistant-ui/core` (transitive) | 0.3.19 | via `@assistant-ui/react` |
| `@ai-sdk/openai-compatible` | 3.0.52 | `3.0.52` |

Line-number citations are for the exact installed versions above; they will drift on upgrade.

---

## 1. AI SDK v7 tool approvals — YES, native, and `needsApproval` is deprecated

**Answer: yes, AI SDK v7 has first-class approval support.** The current API is a **call-level `toolApproval` option**, not a tool-level flag. A tool-level `needsApproval` still exists but is **deprecated** for `generateText` / `streamText` / `ToolLoopAgent` (it remains the idiomatic API only for `WorkflowAgent`).

### `toolApproval` — exact signatures

Declared on all three of `streamText`, `generateText`, and `ToolLoopAgent`:

- `node_modules/ai/dist/index.d.ts:5145` — `streamText(...)` param `toolApproval?: ToolApprovalConfiguration<NoInfer<TOOLS>, RUNTIME_CONTEXT>`
- `node_modules/ai/dist/index.d.ts:4921` — `generateText(...)` param `toolApproval?: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT>`
- `node_modules/ai/dist/index.d.ts:3558` — `ToolLoopAgent` setting `toolApproval?: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT>`

Supporting types:

- `type ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT>` — `node_modules/ai/dist/index.d.ts:3111`. It is either a **generic function** for all tools, or a **per-tool object** keyed by tool name whose values are a `ToolApprovalStatus` or a `SingleToolApprovalFunction`.
- `type ToolApprovalStatus` — `node_modules/ai/dist/index.d.ts:3042`:
  `undefined | 'not-applicable' | 'approved' | 'denied' | 'user-approval' | { type: 'not-applicable' } | { type: 'approved'; reason?: string } | { type: 'denied'; reason?: string } | { type: 'user-approval'; reason?: string }`.
- `type SingleToolApprovalFunction<INPUT, TOOL_CONTEXT, RUNTIME_CONTEXT>` — `node_modules/ai/dist/index.d.ts:3060`.
  `(input, options) => MaybePromiseLike<ToolApprovalStatus>` where `options` is `Omit<ToolExecutionOptions,'abortSignal'|'context'> & { toolContext; runtimeContext }`.
- `type GenericToolApprovalFunction<TOOLS, ...>` — `node_modules/ai/dist/index.d.ts:3069`.
  Receives `{ toolCall, tools, toolsContext, runtimeContext, messages }` and returns `MaybePromiseLike<ToolApprovalStatus>`.
- Precedence: call-level `toolApproval` **overrides** a tool's `needsApproval` default (`node_modules/ai/dist/index.d.ts:3556`, `:4919`, `:5143`).

Cross-reference: `node_modules/ai/docs/03-agents/06-tool-approvals.mdx:8-24` and https://ai-sdk.dev/docs/agents/tool-approvals.

### `needsApproval` — deprecated

- Signature: `needsApproval?: boolean | ((input: INPUT, options: { toolCallId; messages; context }) => boolean | Promise<boolean>)` — `node_modules/ai/docs/07-reference/01-ai-sdk-core/20-tool.mdx:83-88`.
- Explicitly "Deprecated. For `generateText`, `streamText`, and `ToolLoopAgent`, configure approval with `toolApproval` instead. Existing `needsApproval` usages still work as a compatibility fallback." — same line.
- Migration recipe (6 → 7), including `needsApproval: true` → `toolApproval: { myTool: 'user-approval' }` — `node_modules/ai/docs/08-migration-guides/23-migration-guide-7-0.mdx:1260-1311`.
- Runtime still honours it as a fallback: `node_modules/ai/dist/index.js:4693-4705` maps a truthy `needsApproval` result to `{ type: 'user-approval' }`, else `{ type: 'not-applicable' }`.
- One doc sentence says "Use `needsApproval` only with `WorkflowAgent`" (`06-tool-approvals.mdx:337`). Treat this as aspirational guidance, not a hard limit: the migration guide and the runtime code both confirm it still functions as a compatibility fallback for the three main APIs. **Recommendation: use `toolApproval`, not `needsApproval`.**

### How approval states surface

In the text stream (`TextStreamPart`), `node_modules/ai/dist/index.d.ts:3026`:
- `{ type: 'tool-approval-request' }` (`TextStreamToolApprovalRequestPart`) and `{ type: 'tool-approval-response' }` (`TextStreamToolApprovalResponsePart`), plus `{ type: 'tool-output-denied' }`.
- Request shape: `ToolApprovalRequestOutput` — `node_modules/ai/dist/index.d.ts:1182` (`approvalId`, tool call, reason, and an **HMAC-SHA256 `signature`** field).
- Response shape: `ToolApprovalResponseOutput` — `node_modules/ai/dist/index.d.ts:1211` (`approvalId`, `approved`, `reason`).

In `UIMessage` tool parts (`UIToolInvocation`, `node_modules/ai/dist/index.d.ts:2028`) the exact `state` union is:

`'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' | 'output-denied'`

The approval-bearing states carry an `approval` object (`node_modules/ai/dist/index.d.ts:2054-2135`):

```ts
// state: 'approval-requested'
approval: { id: string; approved?: never; descriptor?: unknown; requestReason?: string; isAutomatic?: boolean; signature?: string }
// state: 'approval-responded'
approval: { id: string; approved: boolean; descriptor?: unknown; requestReason?: string; reason?: string; isAutomatic?: boolean; signature?: string }
// state: 'output-available' | 'output-error'  -> approval?: { approved: true; ... }
// state: 'output-denied'                      -> approval:  { approved: false; ... }
```

The `toUIMessageStream` mapper that produces these is `node_modules/ai/dist/index.js:7668-7754` (`tool-approval-request` → `state = 'approval-requested'`, `tool-approval-response` → `state = 'approval-responded'`, `tool-output-denied` → `state = 'output-denied'`).

Client/chat surface: `useChat` returns `addToolApprovalResponse`, typed `ChatAddToolApproveResponseFunction` = `({ id, approved, reason?, options? }) => void | PromiseLike<void>` — `node_modules/ai/dist/index.d.ts:5519`, exposed at `:5711`. Auto-resend is gated by `lastAssistantMessageIsCompleteWithApprovalResponses` — `node_modules/ai/dist/index.d.ts:5902`, exported at `:10025`. Docs example: `node_modules/ai/docs/03-agents/06-tool-approvals.mdx:215-273`.

Security: `experimental_toolApprovalSecret` HMAC-signs approval requests so a client cannot forge a replay; when set, unsigned/forged approvals fail closed — `node_modules/ai/docs/03-agents/06-tool-approvals.mdx:275-331`, `node_modules/ai/dist/index.d.ts:3564-3566`.

---

## 2. Tool `execute` result/error contract

**Result:** `execute` returns `RESULT | Promise<RESULT> | AsyncIterable<RESULT>` (`20-tool.mdx:117-122`). An `AsyncIterable` treats all but the final value as **preliminary** results (same line; consumed at `node_modules/ai/dist/index.js:3565-3575`).

**A thrown error in `execute` does NOT reject the stream.** The executor catches it and emits a `tool-error` part:

- `node_modules/ai/dist/index.js:3587-3601` — `catch (error)` builds `{ type: 'tool-error', toolCallId, toolName, input, error, dynamic, ... }` and returns it as the tool output.
- So multi-step loops continue and the model receives the error on the next step: "When tool execution fails … the AI SDK adds them as `tool-error` content parts to enable automated LLM roundtrips in multi-step scenarios." — `node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx:1143`.
- Distinct from **schema/validation** failures (`NoSuchToolError`, `InvalidToolInputError`, `ToolCallRepairError`, `ToolChoiceViolationError`) which are thrown to your code — `15-tools-and-tool-calling.mdx:1136-1160`.
- Stream part: `TextStreamToolErrorPart` = `{ type: 'tool-error' } & TypedToolError` — `node_modules/ai/dist/index.d.ts:2983`.
- In the UI stream this maps to `UIMessage` part `state: 'output-error'` with a **required `errorText: string`** (and `input: unknown | undefined`, deprecated `rawInput`) — `node_modules/ai/dist/index.d.ts:2110-2135`, mapper at `node_modules/ai/dist/index.js:7746-7780`.

**`toModelOutput` — yes, it exists.** Tool-level option:

`toModelOutput?: ({ toolCallId: string; input: INPUT; output: OUTPUT }) => ToolResultOutput | PromiseLike<ToolResultOutput>` — `node_modules/ai/docs/07-reference/01-ai-sdk-core/20-tool.mdx:170-174`.

- Applied in `createToolModelOutput` — `node_modules/ai/dist/index.js:2040-2060`.
- **Error mode bypasses `toModelOutput`**: for a `tool-error`, `errorMode` is `'json'` (assistant step) or `'text'` (tool-result re-serialization), which short-circuits to `{ type: 'error-json' | 'error-text' }` before the `toModelOutput` branch is reached (`index.js:2046-2055`). So `toModelOutput` only shapes **successful** results.
- Gotcha confirmed in-repo skill: pass the same `tools` to `convertToModelMessages` and `streamText`, or `toModelOutput` is ignored on round-tripped results (`20-tool.mdx:173`; `.agents/skills/tools/SKILL.md:240-241`).

**`ToolResultOutput`** (the model-facing serialization union) — `@ai-sdk/provider-utils@5.0.44/dist/index.d.ts:372`:
`{ type: 'text'; value } | { type: 'json'; value } | { type: 'execution-denied'; reason? } | { type: 'error-text'; value } | { type: 'error-json'; value } | { type: 'content'; value: [...] }`.

Denied approvals are serialized as `{ type: 'execution-denied', reason }` on a synthetic `tool-result` — `node_modules/ai/dist/index.js:5451-5462`.

---

## 3. assistant-ui 0.15.x — tool primitives + native approval seam

**Answer: yes.** The installed `@assistant-ui/react@0.15.20` **does** export the modern toolkit API (`defineToolkit`, `humanTool`, `hitl`, `hitlTool`, `stubTool`, `providerTool`, `externalTool`, `AuiConfig`, `Tools`, `useToolArgsStatus`, `toolApprovalAcceptsText`). This is the same surface the repo's `.agents/skills/tools/SKILL.md` describes. Verified in `node_modules/@assistant-ui/react/dist/index.d.ts:75` and `:82` (export list).

### Tool-call rendering primitives (exact names)

- `ToolCallMessagePartProps<TArgs, TResult>` — defined in `@assistant-ui/core@0.3.19/dist/react/types/MessagePartComponentTypes.d.ts:39`. It is `MessagePartState & ToolCallMessagePart<TArgs, TResult>` plus the callbacks `addResult`, `resume`, and `respondToApproval`.
- Type alias for a component: `ToolCallMessagePartComponent<TArgs, TResult>` (same file, line 63).
- `MessagePartPrimitive`, `ThreadPrimitive`, `MessagePrimitive.Parts` — the primitives that mount parts; `ToolCallMessagePartProps["respondToApproval"]` is forwarded through `MessagePrimitive.Parts` (`@assistant-ui/core/dist/react/primitives/message/MessageParts.d.ts:221`).
- `render` on a toolkit entry receives exactly `ToolCallMessagePartProps` (`.agents/skills/tools/SKILL.md:136-153`).

### The approval seam on the part

`ToolCallMessagePart` — `@assistant-ui/core@0.3.19/dist/types/message.d.ts:194`. Relevant fields:

```ts
readonly approval?: {
  readonly id: string;
  readonly prompt?: string;
  readonly display?: ToolApprovalDisplay;      // "decision" | "select" | "text"
  readonly allowFreeform?: boolean;
  readonly approved?: boolean;
  readonly reason?: string;
  readonly isAutomatic?: boolean;
  readonly options?: readonly ToolApprovalOption[];
  readonly optionId?: string;
  readonly text?: string;
  readonly resolution?: "cancelled" | "expired";
};
readonly interrupt?: { type: "human"; payload: unknown };
```

- `ToolApprovalOptionKind = "allow-once" | "allow-always" | "reject-once" | "reject-always"` — `types/message.d.ts:134`.
- `ToolApprovalResponse` (renderer → runtime) is a 4-variant union: `{ approved }`, `{ optionId }`, `{ approved; optionId }`, or `{ text }`, each optionally with `text`/`reason` — `types/message.d.ts:176-193`.
- `toolApprovalAcceptsText(approval)` helper — `types/message.d.ts:172`.
- Renderer callback: `respondToApproval: (response: ToolApprovalResponse) => Promise<void>` — `MessagePartComponentTypes.d.ts:56-62`. Legal only while `approval.approved === undefined` and no `resolution` is recorded.
- Three-state contract: `approved === undefined` (gate open, only state where you may respond), `true` (allowed, result incoming), `false` (denied; runtime records an `isError` result and fills `approval.reason`). `isAutomatic === true` means a server policy decided, not the user. Cross-checked: `.agents/skills/tools/SKILL.md:203` and https://www.assistant-ui.com/docs/tools/tool-ui (section "Server-side approval gates").

### `humanTool` / `hitl` / `defineToolkit`

- `declare function humanTool(): never` — `@assistant-ui/core/dist/react/model-context/human-tool.d.ts:16`. It is a **compile-time marker with no runtime implementation**; the `"use generative"` compiler detects `execute: humanTool()`, drops it, and stamps `type: "human"` (same file, lines 7-12).
- `hitlTool` and `hitl` are `typeof humanTool`, both **deprecated aliases** — same file, lines 18-24.
- `defineToolkit` — two overloads in `@assistant-ui/core/dist/react/model-context/define-toolkit.d.ts:13-14`; first takes `{ [toolName]: ToolkitDefinitionEntryWithParameters<Args, Result> }`.
- **Important:** `humanTool()` throws at runtime unless the file was processed by the build plugin (`SKILL.md:227-228`). The plugin (`aui()` from `@assistant-ui/vite`, `withAui` from `@assistant-ui/next`) is **not** in this repo's deps, and this repo does **not** use the `"use generative"` compiler. So `defineToolkit`/`humanTool` are **not** on the current critical path.

### External-store integration (this repo's actual path)

This repo does **not** use `@assistant-ui/ai-sdk` (not installed). It bridges its own engine to assistant-ui via `useExternalStoreRuntime` (`src/chat/use-chat-runtime.ts:1,125`). The external-store adapter supports the approval seam directly:

- `onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => Promise<void> | void` — `@assistant-ui/core/dist/runtimes/external-store/external-store-adapter.d.ts:146`.
- Also available: `onAddToolResult?` (`:141`) and `onResumeToolCall?` (`:142-145`).
- `RespondToToolApprovalOptions = { approvalId; approved; optionId?; text?; reason? }` — `@assistant-ui/core/dist/runtime/interfaces/thread-runtime-core.d.ts:51`.
- `AddToolResultOptions = { messageId; toolName; toolCallId; result; isError; artifact?; modelContent? }` — same file, `:32`.
- Runtime event payload `toolApprovalAnswered: { messageId; toolCallId; toolName; approved }` exists for subscription — `thread-runtime-core.d.ts:85-90`.

`respondToApproval` on the part is resolved through `resolveToolApprovalResponse(approval, response)` — `@assistant-ui/core/dist/runtime/utils/resolveToolApprovalResponse.d.ts`.

---

## 4. openai-compatible (`@ai-sdk/openai-compatible@3.0.52`) + progressive disclosure

**Tool-count limits:** the provider imposes **no numeric cap** on the number of tools. `prepareTools` simply maps the full array — `node_modules/@ai-sdk/openai-compatible/src/chat/openai-compatible-prepare-tools.ts:51-68`. Any limit is the upstream server's, not the SDK's.

**Strictness:** per-tool `strict` is **passed through verbatim** if you set it: `...(tool.strict != null ? { strict: tool.strict } : {})` — same file, lines 64 / 21 / 47. Note the correct tool field in v7 is **`strict`** on `tool({...})` (`20-tool.mdx:110-115`), and it is **opt-in per tool**. There is no SDK-level default. A separate provider option `strictJsonSchema` (boolean) controls constrained JSON-schema decoding — `node_modules/@ai-sdk/openai-compatible/src/chat/openai-compatible-chat-language-model-options.ts:23-29`, documented at `node_modules/@ai-sdk/openai-compatible/docs/index.mdx:551-553`.

**Provider-defined tools are dropped with a warning**, not passed through: `toolWarnings.push({ type: 'unsupported', feature: 'provider-defined tool …' })` — `openai-compatible-prepare-tools.ts:52-56`. Relevant if you mix in provider tools.

**Empty tool array is normalized to `undefined`** to avoid upstream errors — same file, line 33.

**Progressive disclosure (the important part):** AI SDK v7 ships native primitives, which are the better lever than manual truncation:

1. **`activeTools`** — `ActiveTools<TOOLS>` option on `streamText` (`node_modules/ai/dist/index.d.ts:3540`), `generateText` (`:4903`), `ToolLoopAgent` (`:5122`). "Limits the tools that are available for the model to call … All tools are active by default." — `node_modules/ai/docs/07-reference/01-ai-sdk-core/02-stream-text.mdx:612-615`.
2. **`deferLoading`** tool flag — "Keep this tool out of the model context until `toolSearch` discovers it." — `20-tool.mdx:69-74`.
3. **`toolSearch()`** — `declare function toolSearch(): Tool<ToolSearchInput, ToolSearchOutput> & { type: 'function' }` — `node_modules/ai/dist/index.d.ts:9509`. Searches deferred tools by name/description, returns **at most five** matches without schemas, and makes matches callable on the **next** model step — `node_modules/ai/docs/07-reference/01-ai-sdk-core/23-tool-search.mdx:30-75`.

So schema-on-demand is a supported, first-class pattern; you do not need to hand-roll tool filtering.

---

## Architectural fit for `sagent-studio`

Confirmed repo facts that shape the design (all verified in source):

- The engine calls `streamText` directly in-browser (`src/chat/engine.ts:116-131`) and pipes through `toUIMessageStream({ stream: result.stream, tools: toolSet, originalMessages, generateMessageId })` (`src/chat/engine.ts:133-138`). **Adding call-level `toolApproval` to that `streamText` call is a one-line change**, and approval states will flow into the `UIMessage` stream automatically.
- Model messages are built with `convertToModelMessages(messages, { tools: toolSet, ignoreIncompleteToolCalls: true })` (`src/chat/engine.ts:111-114`). `convertToModelMessages` already understands `tool-approval-response` parts and synthesizes `execution-denied` results on deny (`node_modules/ai/dist/index.js:5438-5462`).
- The runtime bridge is `useExternalStoreRuntime` (`src/chat/use-chat-runtime.ts:125-140`). It currently passes `onNew/onEdit/onReload/onCancel/onDelete` but **not** `onRespondToToolApproval` or `onAddToolResult`.
- The converter (`src/chat/convert.ts`) is the gap. `convertToolPart` maps only `output-available`, `output-error`, `output-denied` and the default branch (`src/chat/convert.ts:42-55`); it **never reads the `approval` field** and has no branch for `approval-requested` / `approval-responded`. The reverse converter (`toUiParts`) likewise emits only `input-available`/`output-available`/`output-error` (`src/chat/convert.ts:157-168`). **Both must be extended for HITL.** Threading `approval` through is required end-to-end: `UIMessage.part.approval` → `ToolCallMessagePart.approval` → renderer `respondToApproval` → adapter `onRespondToToolApproval` → engine re-invokes `streamText` with the approval response appended.

### Recommendation (ranked)

**R1 — Adopt AI SDK call-level `toolApproval` + assistant-ui `approval` seam over the existing external-store bridge.** Use `toolApproval: { toolName: 'user-approval' | fn }` on the existing `streamText` call, extend `convert.ts` to carry the `approval` object and the two new states, and add `onRespondToToolApproval` to `useExternalStoreRuntime`. This is the smallest change that reuses both libraries' first-class support and keeps approval policy server-of-record-free (browser-only). It also composes with `activeTools`/`deferLoading` for disclosure. **Recommended.**

**R2 — Model approvals as an explicit `data-` part / typed result contract instead of the native seam.** More code, no library support, loses `respondToApproval`/auto-resend, and re-implements state the AI SDK already streams. Only justified if you need approval semantics the two libraries cannot express. Not recommended.

**R3 — Tool-level `needsApproval`.** Works as a compatibility fallback but is deprecated; migrating later costs another pass. Avoid for new code.

### Trade-off matrix

| Dimension | R1 native `toolApproval` + `approval` seam | R2 custom data-part gate | R3 tool-level `needsApproval` |
|---|---|---|---|
| Complexity | Low: one option + converter branches + one adapter callback | High: custom state machine, resend logic, UI | Low, but debt |
| Maintenance | Follows upstream; both libs actively developed | You own all of it | **Deprecated** — forced migration later |
| Correctness | Server re-validates input + policy; optional HMAC secret | You re-implement re-validation | Same as R1 today, but frozen |
| UI leverage | `render` gets `approval`, `respondToApproval`, options, `isAutomatic`, `resolution` | All bespoke | None |
| Multi-step loop | Automatic (`sendAutomaticallyWhen` pattern) | Manual | Automatic |
| Test surface | Stream smoke tests already exist in-repo | New from scratch | — |

### Adoption risk

- `ai@7` is a **major** release with documented breaking changes (`23-migration-guide-7-0.mdx`); the approval surface is new in 7 and therefore less battle-tested than the rest of the SDK. Mitigate by pinning exact versions and covering the new states in `src/chat/stream-smoke.test.ts`.
- `@assistant-ui/react@0.15.x` + `@assistant-ui/core@0.3.x` are **pre-1.0**. The approval fields (`options`, `display`, `resolution`) are documented as host-supplied and partly new. Expect churn on minor bumps; keep the converter as the single adapter boundary so upstream shape changes are localized.
- The repo's `.agents/skills/tools/SKILL.md` describes the `"use generative"` / `@assistant-ui/ai-sdk` / `AISDKToolkit` authoring path. **That path is not installed here.** Do not design against it; design against `useExternalStoreRuntime` + `ToolCallMessagePartProps`, which is what `src/` actually uses.

---

## Verified facts (load-bearing)

1. `ai@7.0.105` supports native approvals via the **call-level** `toolApproval` option on `streamText` (`index.d.ts:5145`), `generateText` (`:4921`), and `ToolLoopAgent` (`:3558`); type `ToolApprovalConfiguration` at `:3111`.
2. Tool-level `needsApproval` is **deprecated** in v7 for those three APIs (still a compatibility fallback): `20-tool.mdx:83`, `23-migration-guide-7-0.mdx:1260-1311`, runtime fallback `dist/index.js:4693-4705`.
3. Approval statuses are `'not-applicable' | 'approved' | 'denied' | 'user-approval'` plus `{ type, reason? }` object forms (`index.d.ts:3042`).
4. `UIMessage` tool-part `state` union is `input-streaming | input-available | approval-requested | approval-responded | output-available | output-error | output-denied` (`index.d.ts:2028-2135`); request carries `approval.requestReason`, `isAutomatic`, and a `signature`.
5. `useChat.addToolApprovalResponse({ id, approved, reason? })` (`index.d.ts:5519`); auto-resend via `lastAssistantMessageIsCompleteWithApprovalResponses` (`:5902`).
6. A thrown `execute` error is **caught** and streamed as a `tool-error` part, not a rejected stream (`dist/index.js:3587-3601`), surfacing as UI part `state: 'output-error'` with required `errorText` (`index.d.ts:2110`).
7. `toModelOutput({ toolCallId, input, output }) => ToolResultOutput` exists (`20-tool.mdx:170`) but is **bypassed for errors** (`errorMode` short-circuit, `dist/index.js:2046-2055`); `ToolResultOutput` union lives at `provider-utils@5.0.44/dist/index.d.ts:372`.
8. `@assistant-ui/react@0.15.20` exports `defineToolkit`, `humanTool` (`(): never`, compile-time marker), and deprecated `hitl`/`hitlTool` (`react/dist/index.d.ts:75,82`; `human-tool.d.ts:16-24`).
9. Tool UI renders through `ToolCallMessagePartProps` (`ToolCallMessagePartComponent`), whose approval fields are `approval.{id,prompt,display,allowFreeform,approved,reason,isAutomatic,options,optionId,text,resolution}`, `interrupt`, `addResult`, `resume`, `respondToApproval` (`core.../types/message.d.ts:194-273`, `.../MessagePartComponentTypes.d.ts:39-65`).
10. `useExternalStoreRuntime` (this repo's bridge) supports `onRespondToToolApproval`, `onAddToolResult`, `onResumeToolCall` (`external-store-adapter.d.ts:141-146`); `RespondToToolApprovalOptions = { approvalId, approved, optionId?, text?, reason? }` (`thread-runtime-core.d.ts:51`).
11. `@ai-sdk/openai-compatible@3.0.52` imposes **no tool-count cap**; forwards per-tool `strict` verbatim (`prepare-tools.ts:51-68`); drops provider-defined tools with a warning (`:52-56`).
12. Progressive disclosure is native: `activeTools` (`index.d.ts:3540`), `deferLoading` (`20-tool.mdx:69`), `toolSearch()` returning ≤5 schema-less matches callable next step (`index.d.ts:9509`, `23-tool-search.mdx:30-75`).

---

## Confidence / gaps

High confidence (read directly from pinned installed source, cross-checked against shipped `.mdx` and the live official docs for the two central claims — AI SDK approval and assistant-ui approval seam).

UNVERIFIED / not covered in this pass:

- **Whether `toUIMessageStream` emits `approval-requested` when `toolApproval` is driven through `streamText` in this exact repo wiring** — the mapper exists (`dist/index.js:7668`) and `streamText` accepts the option, but I did not execute a run. Confirm with a focused test in `src/chat/stream-smoke.test.ts`.
- **`ignoreIncompleteToolCalls: true` interaction with `approval-requested` parts on the second `convertToModelMessages` pass.** This is a real risk (a pending approval part is "incomplete") and must be tested before relying on the two-call approval flow.
- **`@ai-sdk/openai-compatible` server-side behaviour for `tool_choice: 'required'` / `parallel_tool_calls`.** The SDK passes `tool_choice` through (`prepare-tools.ts:70-96`) but I found no `parallel_tool_calls` handling in the package source; behaviour depends on the upstream server and is unverified here.
- **`WorkflowAgent` / `@ai-sdk/policy-opa` policy approvals** referenced in docs but not in scope and not installed; not evaluated.
- **assistant-ui `LocalRuntime` approval gates** (the non-external-store path) — documented but not this repo's path; not evaluated.
- Exact line numbers are version-pinned and will shift on `pnpm update`.

## Limitations

- No runtime/behavioral test was executed; all findings are static source + documentation analysis.
- The report covers the approval and tool-result contracts only. It does not design the UI, the policy UI for `allow-always` grants, or persistence of approval decisions (assistant-ui explicitly leaves persistence host-owned).
- `@assistant-ui/react` pre-1.0 minor releases may rename fields; re-verify against `node_modules` after any upgrade.
