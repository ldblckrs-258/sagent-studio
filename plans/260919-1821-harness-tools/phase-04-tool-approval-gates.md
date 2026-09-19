---
phase: 4
title: "Tool Approval Gates"
status: pending
priority: P1
effort: "10h"
dependencies: [1, 2, 3]
---

# Phase 4: Tool Approval Gates

## Context Links

- Plan: [`plan.md`](./plan.md) — goals 6 and 10; Key Decisions "Native approval
  seam, gated by a blocking spike" and "Permission modes are a ceiling over the
  Phase 4 policy, stored on `ChatThread`"; risk rows for the native pause/resume and
  the `ignoreIncompleteToolCalls` interaction.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- Research: `research/researcher-01-ai-sdk-approval.md` §1 (call-level
  `toolApproval`; `needsApproval` deprecated), §2 (a thrown `execute` error is
  caught and becomes a `tool-error` part; `toModelOutput` is bypassed on error), §3
  (assistant-ui approval seam + `onRespondToToolApproval`).
- Verified SDK facts (installed `ai@7.0.105`):
  - `toolApproval` option on `streamText` — `node_modules/ai/dist/index.d.ts:5145`;
    `ToolApprovalStatus` union at `:3042`.
  - `UIMessage` tool-part states include `approval-requested` /
    `approval-responded` / `output-denied` with an `approval` object —
    `node_modules/ai/dist/index.d.ts:2028-2135`.
  - `ignoreIncompleteToolCalls: true` keeps a tool part only when its state is
    `approval-responded`, `output-available` (non-preliminary), `output-error`, or
    `output-denied` — `node_modules/ai/dist/index.js:11941`. A pending
    `approval-requested` part is therefore dropped from the converted messages.
  - An answered approval is converted to a `tool-approval-response`, and a denied
    approval additionally synthesizes an `execution-denied` tool result —
    `node_modules/ai/dist/index.js:12112`, `:12121`.
- Seam that must change: `src/chat/convert.ts:42-55` (no approval branch),
  `src/chat/sanitize.ts:10` (`TERMINAL_TOOL_STATES` omits the paused states),
  `src/chat/engine.ts:111-114` (`convertToModelMessages` call),
  `src/chat/engine.ts:116-131` (`streamText`), `src/chat/use-chat-runtime.ts:125`
  (`useExternalStoreRuntime` without `onRespondToToolApproval`).
- UI that already renders approvals:
  `src/components/assistant-ui/elements/tool-fallback.aui.tsx:361`
  (`ToolFallbackApproval`), driven by `ToolCallMessagePartProps` from
  `@assistant-ui/core`, mounted through
  `src/components/assistant-ui/elements/thread.aui.tsx:588`.
- Settings and persistence pattern: `src/vault/settings.ts:39`
  (`SandboxSettings`), `:58` (`skills?` optional-with-comment precedent), `:108`
  (`deepMerge`), `:137` (`migrate`); `src/vault/store.ts:309` (`update(patch)`);
  plaintext byte-scan precedent in `src/vault/store.test.ts`.
- Panel registration: `src/ui/shell.tsx:28` (`RailPanelId` union), `:35`
  (`RAIL_IDS`), `:269` (`panels` array), `:317-318` (the `tools` and `sandbox`
  entries to follow).

## Goal

Put a consent step in front of the actions that can destroy, execute, or reach the
network: `write_file`, `remove`, `edit_file`, `move`, `run_js`, `run_python`, and
any user-defined tool whose kind is `sandbox-js` or `http`. `make_dir`, `copy`, and
the read-only tools are deliberately not gated. The policy is the user's, it
persists in the encrypted vault, it defaults to asking, and the answer happens in
the assistant-ui thread where the tool call is already rendered. A denial must
reach the model as a structured result it can respond to, not as a crash.

Three conversation-scoped permission modes (`read_only`, `editing`, `god`) layer a
ceiling over that same decision, so a thread can be constrained below the persisted
policy or, in `god`, auto-approved above it — while a persisted `deny` and the
always-asking `change_mode` tool remain the user's hard stops.
<!-- Updated: Red Team Session 1 - capability-based approval gating -->
<!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
<!-- Updated: Scope Addendum 1 - permission modes -->

## Requirements

**Blocking spike, before any body work.**

- Write `plans/260919-1821-harness-tools/reports/spike-approval-roundtrip.md`
  proving, against the installed packages, the full round-trip:
  1. a `streamText` call with `toolApproval: { <gated>: 'user-approval' }` and an
     `execute` that must not run emits `tool-approval-request`;
  2. `toUIMessageStream` maps that to a `UIMessage` tool part in state
     `approval-requested` carrying `approval.id`;
  3. setting that part to state `approval-responded` with
     `approval.approved: true` and re-invoking `streamText` with
     `convertToModelMessages(..., { ignoreIncompleteToolCalls: true })` executes the
     tool exactly once and produces the final text;
  4. the same sequence with `approval.approved: false` produces no execution and an
     `execution-denied` model result;
  5. `ignoreIncompleteToolCalls: true` drops a still-pending `approval-requested`
     part, so a second pass must never be attempted before the response is recorded.
- The spike is automated where it can be. A `MockLanguageModelV4`
  (`ai/test`, already used at `src/chat/engine.test.ts:78`) drives the two-call
  sequence in `src/chat/approval-roundtrip.test.ts`; the browser-only half (a live
  provider plus a real worker) is recorded in the report file.
- **Decision gate:** if step 1-4 cannot be made to work in this wiring, the phase
  stops and switches to the fallback in "Architecture — fallback" below. The
  decision and the evidence are written into the report file before proceeding.

**Policy.**

- `Settings` gains `approvals: ApprovalSettings` with
  `ApprovalSettings = { tools: Record<string, 'allow' | 'ask' | 'deny'> }` and
  `DEFAULT_APPROVAL_DECISION = 'ask'`. `defaultSettings()` sets `{ tools: {} }`.
  `SETTINGS_VERSION` is not bumped; an existing vault reads the default through
  `deepMerge` (`src/vault/settings.ts:137`).
- Gating is a fixed named set plus the user-tool kind. `src/tools/approval.ts`
  exports `isGatedTool(tool)`, which classifies by two clauses:
  - (a) the built-in destructive name list — `write_file`, `remove`, `edit_file`,
    `move`, `run_js`, `run_python` (`src/tools/builtin/workspace.ts`,
    `src/tools/builtin/code.ts:39`); and
  - (b) a user-defined tool whose registered kind is `sandbox-js` or `http`
    (`src/tools/registry.ts:121`, `src/tools/types.ts:45`), because such a tool runs
    model-authored code or reaches the network.
  `make_dir`, `copy`, `list_dir`, `read_file`, `stat`, `search`, `load_skill`,
  `update_plan`, and `reset_sandbox` are NOT gated. A pure capability rule would
  also gate benign mutators (`make_dir`, `copy`) and read tools, which is rejected
  scope; a pure name list would leave a user `sandbox-js`/`http` tool ungated, which
  is the real hole. Both clauses are required.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- An unknown tool name in the persisted record is ignored, not an error. An unknown
  decision value is coerced to `DEFAULT_APPROVAL_DECISION` on read.
- `src/tools/approval.ts` also exports `decisionFor(settings, toolName)` and
  `normalizeApprovalSettings(raw)`; it imports the settings types from
  `src/vault/settings`, matching the existing import direction in
  `src/tools/store.ts:1-3`.
- Policy edits are persisted with `useVaultStore.getState().update({ approvals: {
  tools: { [name]: decision } })` (`src/vault/store.ts:309`), so they are
  encrypted at rest and serialized through the vault write queue.

**Permission modes (scope addendum).**

- A thread has one `mode: 'read_only' | 'editing' | 'god'`, defaulting to `editing`.
  It is a ceiling over the Phase 4 policy, not a replacement:
  `decision = max(modeCeiling, policy)`, where a tool at or below the ceiling is
  decided by the policy and a tool above the ceiling escalates to a per-call user
  accept.
- Tier membership is exact:
  - `read_only` — only read-only tools plus `change_mode`: `list_dir`, `read_file`,
    `stat`, `search`, `load_skill`, `update_plan`, `change_mode`. Every gated tool
    is therefore above this tier and asks.
  - `editing` (default) — the `read_only` set plus `write_file`, `edit_file`,
    `make_dir`, `copy`, `move`, `run_js`, `run_python`, and user tools of kind
    `sandbox-js` or `http`. `remove` is ABOVE this tier, so it asks.
  - `god` — every gated tool is auto-approved.
- A tool above the current mode's tier triggers a per-call user accept. The accept
  is NOT persisted: it authorizes that one call only, and the next call asks again.
- `god` auto-approves the accept step for every gated tool. It explicitly CANNOT
  auto-approve `change_mode`, which always asks.
- A persisted `deny` always wins, including in `god`: `deny` blocks without any
  prompt.
- `src/tools/approval.ts` gains the tier classification (`modeCeiling` / `tierFor`)
  beside `isGatedTool`, so the ceiling and the gate read one table.
- `change_mode` (`src/tools/builtin/mode.ts`) is model-callable and is NOT gated by
  the mode: it may run in every mode and ALWAYS asks the user. On accept it sets the
  thread's mode, in either direction. It can never be auto-approved, including in
  `god`.
- The composer toggle (`src/ui/composer-controls.tsx`, `ComposerControls`) sets the
  active thread's mode directly, with no tool call and no approval. Both paths write
  the same thread-level field through the patch helper in `src/chat/threads.ts`.
- The mode lives on `ChatThread` (`src/chat/types.ts:26`) as a sibling of
  `workspaceName` (`:34`), NOT on `ThreadConfig`, because the Config panel rebuilds
  `config` from `threadConfigPatch` (`src/chat/config.ts:52-77`) and would drop it.
  `validateThread` (`src/chat/persistence.ts:25-59`) is additive and tolerant: an
  absent or unrecognized `mode` reads as `editing`, and new threads default to
  `editing`.
<!-- Updated: Scope Addendum 1 - permission modes -->

**Native path (primary).**

- `src/chat/approval.ts` exports `createToolApproval(settings)` returning the
  per-tool `toolApproval` object for `streamText`: a gated tool with decision `ask`
  maps to `'user-approval'`, `allow` to `'approved'`, `deny` to `'denied'`.
  Non-gated tools are absent from the object, which leaves them automatically
  approved.
- `buildRunStream` (`src/chat/engine.ts:92`) passes that object to `streamText`.
- `convertToolPart` (`src/chat/convert.ts:33`) carries `part.approval` through,
  maps `approval-requested` and `approval-responded` to a `tool-call` part with the
  `approval` field and no `result`, and uses `part.approval?.reason` for
  `output-denied`. It also synthesizes `approval.options` from the policy:
  `[{ id: 'allow-once', kind: 'allow-once' }, { id: 'allow-always',
  kind: 'allow-always' }]` (`ToolApprovalOptionKind`,
  `@assistant-ui/core/dist/types/message.d.ts:135`). Without those options the
  native card cannot express `allow-always`, so this synthesis is required for
  acceptance criterion 6. `toUiParts` (`:147`) preserves `approval`, its `options`,
  and the paused states in the reverse direction so `onEdit` round-trips. Phase 1's
  `isError` derivation from `envelope.ok` on the `output-available` branch is
  preserved.
  <!-- Updated: Red Team Session 1 - preserve phase-1 isError derivation -->
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- `sanitize.ts` adds `PAUSED_TOOL_STATES = new Set(['approval-requested',
  'approval-responded'])`. `sanitizePartial(message)` leaves a paused part intact at
  the end of a live run (that is a legitimate waiting state, not an interrupted
  call). `sanitizePartial(message, { expireApprovals: true })` converts a paused
  part to `output-error` with the message "The approval request expired when the
  session ended." and sets `approval.resolution: 'expired'`; `rehydrateThread`
  (`:48`) uses that variant, because a reload cannot resume a stream. Both behaviors
  get tests.
  <!-- Updated: Red Team Session 1 - stale approval expiry -->
- `ChatEngine` gains
  `respondToApproval(threadId, { approvalId, approved, optionId?, reason? }):
  Promise<void>`. It locates the assistant message holding the tool part with
  `approval.id === approvalId`, sets `state: 'approval-responded'` and
  `approval: { ...existing, approved, optionId, reason }`, persists, then resumes the
  run. `optionId: 'allow-always'` writes the tool's decision to the encrypted policy;
  `'allow-once'` grants only the current call. A response for an approval that is not
  the latest pending one for the thread, or that carries neither `approved` nor a
  known `optionId`, is rejected without starting a run.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- A pending approval expires in-session when a newer run starts for the same thread,
  or when a newer message exists after the paused part: set
  `approval.resolution: 'expired'` and reject any `respondToApproval` for an approval
  that is not the latest pending one. This prevents a late answer to a stale request
  from truncating the turns that happened after it.
  <!-- Updated: Red Team Session 1 - stale approval expiry -->
- Resuming uses the same assistant message, so the continuation REPLACES/merges that
  message in place rather than appending a placeholder with a duplicate id.
  `startRun` gains an options argument `{ resumeAssistantId?: string }`. When set, the
  existing assistant message with that id is updated in place, and the responded
  assistant message is passed explicitly into `buildRunStream` as part of the model
  messages, so `convertToModelMessages` sees the `approval-responded` part.
  `toUIMessageStream({ originalMessages })` then merges the continuation into the same
  message (`src/chat/engine.ts:133-138`). A test asserts exactly one assistant message
  per id after resume.
  <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
- `use-chat-runtime.ts` supplies
  `onRespondToToolApproval: ({ approvalId, approved, optionId, reason }) =>
  engine.respondToApproval(threadId, { approvalId, approved, optionId, reason })`
  (`src/chat/use-chat-runtime.ts:125-140`).
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->

**UI.**

- A new `src/ui/panels/approvals.tsx` lists the gated tool names by running
  `isGatedTool` over the built-in names and the registered user tools — the same
  predicate the gate uses, not a duplicated literal array — with a three-state
  control (`Allow` / `Ask` / `Deny`), defaulting to `Ask`, persisted on change. It is
  registered in `src/ui/shell.tsx` by adding the id to the `RailPanelId` union and to
  `RAIL_IDS`, importing the component, and adding an entry to the `panels` array
  next to `tools` and `sandbox`.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- No new approval card is built: `ToolFallbackApproval`
  (`src/components/assistant-ui/elements/tool-fallback.aui.tsx:361`) already
  renders `approval`, including `approval.options`, and calls `respondToApproval`.
  This phase only makes the data reach it.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- Panels are not unit-tested in this repository (there is no existing panel test);
  the policy logic is covered in `src/tools/approval.test.ts` instead.

## Architecture

**Native path, end to end.**

```
streamText({ ..., toolApproval })                      // engine buildRunStream
  → provider asks to call `write_file`
  → SDK emits tool-approval-request
  → toUIMessageStream → UIMessage tool part state 'approval-requested' + approval.id
  → convert.ts → ToolCallMessagePart with approval
  → thread.aui.tsx:588 → ToolFallbackApproval renders Allow/Deny
  → respondToApproval → onRespondToToolApproval (use-chat-runtime)
  → engine.respondToApproval: part.state='approval-responded',
       approval.approved / approval.optionId set; stale approvals get resolution='expired'
  → engine.startRun(base, { resumeAssistantId })   // updates the existing assistant
       message in place; the responded message is passed in explicitly
  → convertToModelMessages(messages, { ignoreIncompleteToolCalls: true })
       keeps the approval-responded part (ai/dist/index.js:11941)
       emits tool-approval-response (ai/dist/index.js:12112)
       on deny also emits execution-denied (ai/dist/index.js:12121)
  → streamText continues; the tool executes only on approve
  → toUIMessageStream merges the continuation into the same assistant id
```

Two properties make this work and are the spike's subject:

1. The engine has no server and no pause primitive. It "pauses" by letting the
   stream end with a pending approval part, then starting a new stream when the
   user answers. State lives entirely in the app-owned `UIMessage[]`.
2. `ignoreIncompleteToolCalls: true` keeps exactly the states that carry an answer.
   A second pass attempted while the part is still `approval-requested` would drop
   the tool call entirely, so the engine must record the response before it starts
   the resuming run. That ordering is a named requirement, not an implementation
   detail.

**Why the policy is not enforced in `execute`.** A pre-check inside `execute` would
have to answer before the tool runs, which means either throwing (losing the hint,
per `research/researcher-01-ai-sdk-approval.md` §2) or returning a synthetic
"approval required" result and re-running — the fallback. The native seam is
preferred because it keeps the policy decision out of the tool body, uses the SDK's
own state machine, and reaches the already-built approval UI. The fallback exists
because the native seam is new in AI SDK v7 and this repo's wiring is unusual.

**Fallback (only if the spike fails).**

The fallback is a policy pre-check at the top of each gated tool's `execute`,
returning a structured `approval_required` envelope carrying the tool name and a
`grantKey`. The engine stores a one-shot, per-thread grant in memory
(`Map<threadId, Set<grantKey>>`), where `grantKey` is derived from the tool name plus
a canonical serialization of the tool input (stable key order) — NOT from the
`toolCallId`, which changes on a rerun and would make the grant miss. When the input
is not canonicalizable, the paused tool part id is the equivalent key. The UI path
changes shape: an `approval_required` envelope is a normal tool result, so the
approval card is rendered from a `data-approval` UI part that the engine appends
alongside the tool result (`convert.ts:100-102` already maps `data-*` parts, `:198`
already maps them back). Answering calls `respondToApproval`, which records the grant,
marks the `data-approval` part resolved, and reruns; the second pass sees the grant in
`execute` and proceeds. The fallback records which of the two second-pass shapes it
implements: replaying the paused tool part, or re-invoking the model.

`deny` is defined in the fallback too: the pre-check returns a `denied` envelope and
does not execute, with a test asserting the tool body never runs. `allow-always`
writes the vault policy. The fallback costs one extra model round-trip per first-time
approval and one extra UI component (`src/ui/approval-card.tsx`). The phase's file
list below lists the fallback files separately so the spike's outcome selects them
rather than forcing both.
<!-- Updated: Red Team Session 1 - fallback grant key + deny defined -->

## Files to Create / Modify

Create (native path):

- `src/tools/approval.ts`, `src/tools/approval.test.ts` — gate classification plus
  the mode tier and `decision = max(modeCeiling, policy)`
- `src/chat/approval.ts`, `src/chat/approval.test.ts`
- `src/chat/approval-roundtrip.test.ts` — the automated half of the spike
- `src/ui/panels/approvals.tsx`
- `src/tools/builtin/mode.ts`, `src/tools/builtin/mode.test.ts` — the `change_mode`
  tool provider (always asks, never gated by the mode, never auto-approved)
- `src/chat/types.test.ts` — the `ChatMode` union and the `ChatThread.mode` default
- `plans/260919-1821-harness-tools/reports/spike-approval-roundtrip.md` — blocking
  manual artifact and decision record
<!-- Updated: Scope Addendum 1 - permission modes -->

Create (fallback only, if the spike fails):

- `src/ui/approval-card.tsx`
- `src/chat/approval-grant.ts`, `src/chat/approval-grant.test.ts`

Modify:

- `src/vault/settings.ts` — `ApprovalSettings`, `DEFAULT_APPROVAL_DECISION`,
  `Settings.approvals`, `defaultSettings()`. The gated set itself lives in
  `isGatedTool`: the named destructive built-ins plus user-tool kind. No separate
  `APPROVAL_GATED_TOOL_NAMES` array is introduced.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- `src/tools/registry.ts` — expose a user-defined tool's `kind` so `isGatedTool` can
  apply clause (b) (`sandbox-js`/`http`).
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- `src/chat/convert.ts` — approval pass-through, paused states, denied reason, and
  the synthesized `approval.options`.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- `src/chat/sanitize.ts` — `PAUSED_TOOL_STATES`, `expireApprovals` option, and
  `resolution: 'expired'`.
  <!-- Updated: Red Team Session 1 - stale approval expiry -->
- `src/chat/engine.ts` — `toolApproval`, `respondToApproval` (with the stale-approval
  rejection and `optionId` handling), the `startRun` resume option that updates the
  existing assistant message in place, and an `approvalSettings` read from
  `getSettings()`. It also reads the thread's `mode` and passes it into the per-run
  approval object, keeping `change_mode` at `'user-approval'` in every mode.
  <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/chat/types.ts` — `ChatMode` union and the optional `mode` on `ChatThread`
  (`:26`), as a sibling of `workspaceName` (`:34`); NOT on `ThreadConfig`.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/chat/persistence.ts` — tolerant `mode` read in `validateThread` (`:25-59`);
  an absent or unrecognized value reads as `editing`.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/chat/threads.ts` — a thread-level patch helper beside `patchThreadConfig`
  (`:60`) for fields like `mode`, used by both `change_mode` and the composer toggle;
  new threads default to `editing`.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/tools/types.ts` — optional `mode?: ThreadModePort` on `ToolRuntimePorts`
  (`:58`), following the `ThreadPlanPort` pattern, so `change_mode` writes the active
  thread's mode and cannot address another thread.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/ui/composer-controls.tsx` — the mode toggle in `ComposerControls` (`:196`),
  writing the active thread's mode through the thread-level patch helper with no tool
  call and no approval.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/chat/use-chat-runtime.ts` — `onRespondToToolApproval` forwards `optionId`.
- `src/ui/shell.tsx` — register the Approvals panel (`RailPanelId`, `RAIL_IDS`,
  import, `panels` entry).
- `src/chat/convert.test.ts`, `src/chat/sanitize.test.ts`,
  `src/chat/engine.test.ts` — new cases.
- `src/chat/persistence.test.ts`, `src/chat/threads.test.ts` — the tolerant `mode`
  read, the mode round-trip after reload, the Config-panel-save regression, and the
  thread-level patch helper. No `.test.tsx` convention exists in this repository
  (verified: zero `*.test.tsx` under `src/`), so the composer toggle's assertions live
  in `src/chat/threads.test.ts` (the helper the toggle calls) rather than a new
  component test file.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- `src/chat/transport.test.ts` — regression: the shared `buildRunStream` still
  behaves for the transport call site.
  <!-- Updated: Red Team Session 1 - both buildRunStream call sites -->
- `src/vault/settings.test.ts`, `src/vault/store.test.ts` — new default, migration
  read, and plaintext byte-scan for the policy.

## Test Plan

Automated — `src/chat/approval-roundtrip.test.ts` (the spike, in CI)

- Call 1 requests approval: the tool's `execute` is not called, the stream ends with
  a tool part in state `approval-requested`, and `approval.id` is non-empty.
- Approve: after marking `approval-responded` with `approved: true`, a second
  `streamText` call executes the tool exactly once (asserted with a counter) and the
  final text is produced.
- Deny: after marking `approval-responded` with `approved: false`, the tool is never
  executed and the converted model messages contain an `execution-denied` result.
- A pending `approval-requested` part is dropped by
  `convertToModelMessages(..., { ignoreIncompleteToolCalls: true })`, asserted
  directly, so the ordering requirement is pinned by a test rather than a comment.
- An `allow` policy never emits an approval request.
- A `deny` policy prevents execution without any user response.
- `allow-always`: an `approval.options` entry with `kind: 'allow-always'` writes the
  tool's decision to the policy, and a later call for the same tool emits no request.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- After resume, exactly one assistant message exists for the resumed id (not two).
  <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->

Unit — `src/tools/approval.test.ts`

- `isGatedTool` returns gated for each named built-in: `write_file`, `remove`,
  `edit_file`, `move`, `run_js`, `run_python`.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- `isGatedTool` returns gated for a user-defined `sandbox-js` tool and a user-defined
  `http` tool.
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- `isGatedTool` is not gated for `make_dir`, `copy`, `list_dir`, `read_file`,
  `stat`, `search`, `load_skill`, `update_plan`, or `reset_sandbox`.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- A user `sandbox-js` tool is gated even though its name is not in any built-in list.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
- `decisionFor` returns `ask` for an absent tool, the persisted value when present,
  and `ask` for an unrecognized persisted string.
- `normalizeApprovalSettings` drops forbidden keys (`__proto__`, `constructor`,
  `prototype`), non-string decisions, and unknown tool names, and never throws on a
  malformed record.

Unit — `src/chat/approval.test.ts`

- `createToolApproval` maps `ask` → `'user-approval'`, `allow` → `'approved'`,
  `deny` → `'denied'`, and omits non-gated tools.
- An empty policy produces an empty object, which leaves every tool unapproved by
  the gate.

Unit — `src/chat/convert.test.ts`

- `approval-requested` maps to a `tool-call` part carrying `approval` with no
  `result` and no `isError`.
- `approval-responded` with `approved: true` maps with `approval.approved === true`.
- `output-denied` uses `approval.reason` as the result text when present.
- An `approval-requested` part for an `ask`-gated tool carries synthesized
  `approval.options` with `allow-once` and `allow-always`, so the card can express
  `allow-always`.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- `toUiParts` round-trips a part carrying `approval` and its `options` back to the
  paused state.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->

Unit — `src/chat/sanitize.test.ts`

- `sanitizePartial` leaves an `approval-requested` part intact.
- `sanitizePartial(message, { expireApprovals: true })` converts it to
  `output-error` with the expiry message, sets `approval.resolution: 'expired'`, and
  drops any stale `approval` result.
  <!-- Updated: Red Team Session 1 - stale approval expiry -->
- `rehydrateThread` expires a paused part, and leaves a completed part untouched.

Unit — `src/chat/engine.test.ts`

- `respondToApproval` on an unknown `approvalId` is a no-op and does not start a
  run.
- `respondToApproval` marks the right part, persists, and starts exactly one new
  stream whose model messages include the approval response.
- `respondToApproval` for a non-latest pending approval (a newer run started, or a
  newer message exists after the paused part) is rejected and starts no run; the
  stale part carries `approval.resolution: 'expired'`.
  <!-- Updated: Red Team Session 1 - stale approval expiry -->
- The resumed run writes into the same assistant message id rather than appending a
  second assistant message, asserted by counting messages with that id.
  <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
- The responded assistant message is passed into `buildRunStream`, so
  `convertToModelMessages` sees the `approval-responded` part on the resume pass.
  <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
- `optionId: 'allow-always'` persists the tool decision; `optionId: 'allow-once'`
  does not.
  <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- `toolApproval` is present on the `streamText` call when the policy gates a tool,
  and absent-equivalent when the policy allows everything (asserted through the mock
  model's recorded call, following the existing `toolNamesOf` pattern at `:196`).

Unit — mode ceiling and `change_mode` (scope addendum)

- `modeCeiling('read_only')` permits exactly `list_dir`, `read_file`, `stat`,
  `search`, `load_skill`, `update_plan`, `change_mode`; a gated tool outside that set
  (`write_file`, `edit_file`, `make_dir`, `copy`, `move`, `run_js`, `run_python`, a
  user `sandbox-js`/`http` tool) escalates to a per-call accept.
- `modeCeiling('editing')` adds the `write_file`, `edit_file`, `make_dir`, `copy`,
  `move`, `run_js`, `run_python`, and user `sandbox-js`/`http` set above the
  `read_only` set, and leaves `remove` above the tier, so `remove` escalates.
- `modeCeiling('god')` leaves every gated tool auto-approved; `decision = max` still
  returns `deny` when the persisted policy denies.
- `change_mode` is not gated by the mode, maps to `'user-approval'` in every mode,
  and is never auto-approved in `god`.
- An above-tier accept is per-call: the same tool on the next call asks again, and no
  policy write occurs.
- `buildRunStream` passes `thread.mode` into the per-run approval object, asserted
  through the mock model's recorded call.
- `src/chat/types.test.ts`: the three-value `ChatMode` union and the `mode` default.
- `src/chat/persistence.test.ts`: a thread saved with a mode reloads with it; an
  absent or unrecognized `mode` reads `editing`; a Config-panel-style save
  (`threadConfigPatch` → `{ ...thread, config }`) leaves `thread.mode` intact.
- `src/chat/threads.test.ts`: the thread-level patch helper sets `mode` and stamps
  `updatedAt` (the composer toggle's write path).
- `src/tools/builtin/mode.test.ts`: `change_mode` accepts `{ mode }`, rejects an
  unknown value as `invalid_input`, is available without a gated-tool decision, and
  calls the mode port with the requested mode on accept.
<!-- Updated: Scope Addendum 1 - permission modes -->

Settings and persistence

- `defaultSettings().approvals` is `{ tools: {} }`.
- `migrate(1, { sandbox: {...} })` (no `approvals`) yields the default.
- A persisted `approvals` record with a bogus decision reads back as `ask`.
- A byte scan of the vault record for a saved `approvals` policy finds no plaintext
  tool name or decision marker, following the existing pattern in
  `src/vault/store.test.ts`.

Fallback (only if the spike fails) — `src/chat/approval-grant.test.ts`

- The grant key is stable across a rerun of the same tool with the same input (the
  `toolCallId` changes but the grant still matches), and is not granted for a
  different input.
  <!-- Updated: Red Team Session 1 - fallback grant key + deny defined -->
- A `deny` decision returns a `denied` envelope and the tool body is never executed.
  <!-- Updated: Red Team Session 1 - fallback grant key + deny defined -->

Manual — `reports/spike-approval-roundtrip.md`

- Live provider turn that requests approval, renders the card, approves, and
  completes; a second turn that denies and shows the structured denial in the
  transcript. Recorded with date, build hash, browser version, and observed result.

## Implementation Steps

1. **Spike.** Write the failing-first test file
   `src/chat/approval-roundtrip.test.ts` and iterate until the five automated
   assertions pass. Then run the browser-only half against a live provider and
   write `reports/spike-approval-roundtrip.md` with the observed results and the
   native-vs-fallback decision. Do not proceed past this step on a failed native
   path without recording the fallback decision.
2. Add `ApprovalSettings` and `DEFAULT_APPROVAL_DECISION` to
   `src/vault/settings.ts`. Expose a user tool's `kind` from the registry and write
   `src/tools/approval.ts` with `isGatedTool` (named destructive built-ins plus user
   `sandbox-js`/`http` kind), and its test. Run the settings tests.
   <!-- Updated: Red Team Session 1 - capability-based approval gating -->
   <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
3. Add `src/chat/approval.ts` (`createToolApproval`) and its test. Verify the
   object shape against `ToolApprovalConfiguration` (`ai/dist/index.d.ts:3111`) with
   `pnpm build`.
4. Extend `src/chat/convert.ts` for the paused states, the `approval` field, and the
   synthesized `approval.options`; then `src/chat/sanitize.ts` for
   `PAUSED_TOOL_STATES`, the `expireApprovals` option, and
   `approval.resolution: 'expired'`. Update both test files.
   <!-- Updated: Red Team Session 1 - allow-always + stale approval expiry -->
5. Wire `toolApproval` into `buildRunStream` (`src/chat/engine.ts:92`) from
   `getSettings()?.approvals`.
6. Implement `respondToApproval` (including `optionId`, the stale-approval rejection,
   and in-session expiry when a newer run starts) and the `startRun` resume option
   that updates the existing assistant message in place and passes the responded
   message into `buildRunStream`. Add the engine tests. Keep the existing
   single-run-per-thread and cancel semantics intact: an approval response during an
   in-flight run for the same thread must abort the previous run through the existing
   `startRun` path (`:246-248`).
   <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
7. Add `onRespondToToolApproval` (forwarding `optionId`) to `use-chat-runtime.ts` and
   a `respondToApproval` method on the `ChatEngine` interface
   (`src/chat/engine.ts:45`).
   <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
8. Build `src/ui/panels/approvals.tsx` and register it in `src/ui/shell.tsx`
   (`RailPanelId`, `panels`). List the gated names by running `isGatedTool` over the
   built-in names and registered user tools. Persist through
   `useVaultStore.getState().update`.
   <!-- Updated: Red Team Session 1 - capability-based approval gating -->
   <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
9. Add `ChatMode` and the optional `mode` field to `ChatThread` in
   `src/chat/types.ts:26`, and the tolerant read in `validateThread`
   (`src/chat/persistence.ts:25-59`): an absent or unrecognized `mode` reads as
   `editing`, and new threads are created with `mode: 'editing'`. Add the
   thread-level patch helper to `src/chat/threads.ts` beside `patchThreadConfig`
   (`:60`) as the only writer of thread-level fields like `mode`. Write
   `src/chat/types.test.ts` and the persistence/threads cases.
   <!-- Updated: Scope Addendum 1 - permission modes -->
10. Add the tier classification to `src/tools/approval.ts`: `modeCeiling(mode)` maps
    each mode to the exact tool set it permits, and the decision is
    `max(modeCeiling, policy)` so a tool above the ceiling escalates to an accept and
    a persisted `deny` still wins. Cover both tier boundaries in `approval.test.ts`.
    <!-- Updated: Scope Addendum 1 - permission modes -->
11. Wire `thread.mode` into the decision inside `buildRunStream`
    (`src/chat/engine.ts:92`): the per-run approval object is computed from the
    thread's mode and `getSettings()?.approvals`. A tool above the ceiling maps to
    `'user-approval'`; `god` maps every gated tool to `'approved'` and
    `change_mode` to `'user-approval'`.
    <!-- Updated: Scope Addendum 1 - permission modes -->
12. Implement the escalation accept flow: an accept for a tool above the mode's tier
    authorizes exactly one call and is not persisted, and a `deny` still blocks. Add
    the engine tests, including that the next call asks again.
    <!-- Updated: Scope Addendum 1 - permission modes -->
13. Add `ThreadModePort` and the optional `mode` member to `ToolRuntimePorts`
    (`src/tools/types.ts:58`), then write `src/tools/builtin/mode.ts` with
    `createModeToolProvider()` and `NAMES = ['change_mode']`. `change_mode` accepts
    `{ mode }`, is not gated by the mode ceiling, and ALWAYS asks the user; on accept
    it sets the thread's mode through the thread-level patch helper. It is excluded
    from `god` auto-approval by construction, because the approval object maps it to
    `'user-approval'` in every mode. Write `src/tools/builtin/mode.test.ts`.
    <!-- Updated: Scope Addendum 1 - permission modes -->
14. Add the mode toggle to `src/ui/composer-controls.tsx` (`ComposerControls`,
    `:196`), setting the active thread's mode through the same patch helper, with no
    tool call and no approval.
    <!-- Updated: Scope Addendum 1 - permission modes -->
15. Persistence round-trip and regression: a thread saved with a mode reloads with
    the same mode; an old thread without `mode` reads `editing`; a Config-panel-style
    save (`threadConfigPatch` → `{ ...thread, config }`,
    `src/ui/panels/chat-config.tsx:75`) leaves `thread.mode` intact. Add the mode
    cases to `src/chat/persistence.test.ts` and `src/chat/threads.test.ts` (there is
    no `.test.tsx` convention in this repository, so the composer toggle's assertions
    live in the helper's test).
    <!-- Updated: Scope Addendum 1 - permission modes -->
16. Run `pnpm test`, then `pnpm lint` and `pnpm build`.
17. Only if the spike failed: replace steps 3, 5, and 7 with the fallback files and
    the `data-approval` rendering path. Key the grant on tool name plus canonical
    input (not `toolCallId`), define `deny` as a `denied` envelope with no execution,
    record which second-pass shape is used, and record the change in the spike report.
    <!-- Updated: Red Team Session 1 - fallback grant key + deny defined -->

## Todo

- [ ] Automated approval round-trip test (`approval-roundtrip.test.ts`) green
- [ ] Browser-only round-trip recorded in `reports/spike-approval-roundtrip.md`
      with the native-vs-fallback decision
- [ ] `ApprovalSettings` + defaults + migration read in `src/vault/settings.ts`,
      with the gated set defined once in `isGatedTool`
      <!-- Updated: Red Team Session 1 - capability-based approval gating -->
      <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- [ ] Registry user-tool `kind` exposure + `src/tools/approval.ts` with `isGatedTool`
      (named destructives + user `sandbox-js`/`http`), `decisionFor`,
      `normalizeApprovalSettings` + tests, including a gated user `sandbox-js` tool
      and ungated `make_dir`/`copy`
      <!-- Updated: Red Team Session 1 - capability-based approval gating -->
      <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- [ ] `src/chat/approval.ts` `createToolApproval` + tests
- [ ] `convert.ts` carries `approval`, both paused states, and the synthesized
      `approval.options`, both directions
      <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- [ ] `sanitize.ts` keeps paused states live, expires them on rehydrate with
      `resolution: 'expired'`
      <!-- Updated: Red Team Session 1 - stale approval expiry -->
- [ ] `toolApproval` wired into `buildRunStream`
- [ ] `respondToApproval` + `startRun` resume option, replacing/merging the same
      assistant message and rejecting a non-latest approval
      <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
- [ ] `onRespondToToolApproval` in `use-chat-runtime.ts`, forwarding `optionId`
- [ ] Approvals policy panel registered in `src/ui/shell.tsx`, listing the gated
      names from `isGatedTool`
      <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- [ ] `ChatMode` + `ChatThread.mode` (sibling of `workspaceName`); absent reads
      `editing`; new threads default to `editing`
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Thread-level patch helper in `src/chat/threads.ts` beside `patchThreadConfig`
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Tier classification and `decision = max(modeCeiling, policy)` in
      `src/tools/approval.ts`, with the exact `read_only`/`editing`/`god` tier lists
      tested
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Engine reads `thread.mode` for the decision; the escalation accept is per-call
      and not persisted; `god` auto-approves every gated tool
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] `src/tools/builtin/mode.ts` `change_mode`: always asks, never gated by mode,
      never auto-approved in `god`, sets the thread mode on accept
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Composer toggle in `src/ui/composer-controls.tsx` writing the thread mode with
      no tool call
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] `mode` persistence round-trip and Config-panel-save regression
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Settings tests: default, migration, bogus decision, no plaintext policy
- [ ] Fallback (if needed): grant keyed on tool name + canonical input, `deny`
      defined, second-pass shape recorded
      <!-- Updated: Red Team Session 1 - fallback grant key + deny defined -->
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [ ] The automated round-trip test proves the tool does not execute before
      approval, executes exactly once after approval, and never executes on denial.
- [ ] A denial produces an `execution-denied` model result and a rendered denial in
      the thread.
- [ ] A pending `approval-requested` part is provably dropped by
      `ignoreIncompleteToolCalls: true`, and the engine is proven to record the
      response before resuming.
- [ ] The resumed stream continues the same assistant message; no second assistant
      bubble appears, and exactly one assistant message exists per id after resume.
      <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message -->
- [ ] `allow` skips the gate entirely; `deny` blocks with no user interaction;
      `ask` is the default for a tool with no persisted decision.
- [ ] Gating covers the named destructives (`write_file`, `remove`, `edit_file`,
      `move`, `run_js`, `run_python`) plus user `sandbox-js`/`http` tools, while
      `make_dir`, `copy`, and the read-only tools stay ungated.
      <!-- Updated: Red Team Session 1 - capability-based approval gating -->
      <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- [ ] `allow-always` is reachable from the native card and persists the decision;
      `allow-once` grants only the current call.
      <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options -->
- [ ] A late answer to a stale approval is rejected, and the stale part carries
      `resolution: 'expired'`, so intervening turns are not truncated.
      <!-- Updated: Red Team Session 1 - stale approval expiry -->
- [ ] The policy persists encrypted, survives reload, and its plaintext is absent
      from IndexedDB.
- [ ] A vault record written before this phase loads and reads `approvals` as the
      default, with no `SETTINGS_VERSION` bump.
- [ ] An existing thread persisted with a pending approval rehydrates without
      poisoning the next request (the paused part is expired, and the next
      conversion succeeds).
- [ ] Each mode's ceiling is enforced: `read_only` escalates `write_file` and
      `run_js` to a per-call accept, `editing` escalates `remove`, and `god` does not
      ask for any gated tool.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] An above-tier accept authorizes one call only and is not persisted; the next
      call asks again.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] `change_mode` always asks the user in every mode, including `god`, and a
      persisted `deny` still blocks even in `god`.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] `mode` persists on `ChatThread`, survives reload, and survives a Config-panel
      save; an absent `mode` reads `editing`.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| The native pause/resume does not work in this wiring | Medium × High | The spike is the first step and a hard gate; the fallback design is fully specified and its file list is pre-declared, so the switch is a decision, not a re-plan. |
| A second stream starts while the part is still `approval-requested`, silently dropping the tool call | Medium × High | The engine records the response and flips the state before `startRun`; a test asserts the drop behavior directly so the ordering cannot regress silently. |
| Resuming appends a second assistant message and confuses the provider | Medium × High | `startRun` updates the existing assistant message in place and passes the responded message explicitly into `buildRunStream`, so `convertToModelMessages` sees the `approval-responded` part and `originalMessages` merges the continuation; a test asserts a single assistant message per id after resume. <!-- Updated: Red Team Session 1 - resume replaces/merges the assistant message --> |
| A late answer to a stale approval truncates the turns that happened after it | High × Medium | Pending approvals expire in-session when a newer run starts or a newer message follows the paused part (`resolution: 'expired'`), and `respondToApproval` rejects a non-latest approval. A test covers the late answer. <!-- Updated: Red Team Session 1 - stale approval expiry --> |
| A user `sandbox-js` or `http` tool executes without approval because it is not in the named list | Critical × High | `isGatedTool`'s clause (b) gates any user-defined tool whose kind is `sandbox-js` or `http`, so model-authored code and network tools are covered even though they are not named. A test gates a user `sandbox-js` tool and a user `http` tool. <!-- Updated: Red Team Session 1 - capability-based approval gating --> <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) --> |
| `allow-always` is unreachable, so the card can only answer once | Medium × Medium | `convertToolPart` synthesizes `approval.options` with `allow-once`/`allow-always`, and `respondToApproval` handles `optionId`; a test asserts the option writes the policy. <!-- Updated: Red Team Session 1 - allow-always via synthesized approval.options --> |
| The sanitizer rewrites a legitimately pending approval into an error at the end of a run | High × Medium | `PAUSED_TOOL_STATES` is added before any UI wiring, with tests for both the live and rehydrate variants. |
| A persisted pending approval poisons the next request after reload | Medium × High | `rehydrateThread` expires paused parts and the next conversion is asserted to succeed, mirroring the existing poisoned-thread test at `src/chat/engine.test.ts:423`. |
| Approval responses are forgeable by anyone with the page | Low × Low | Browser-only, single-user, no server of record; `experimental_toolApprovalSecret` (HMAC) exists (`research/researcher-01-ai-sdk-approval.md` §1) but is not added because there is no remote caller to forge against. Recorded as an accepted limitation. |
| `ai@7` / `@assistant-ui` pre-1.0 field churn breaks the converter | Medium × Medium | `src/chat/convert.ts` stays the single adapter boundary; the round-trip test pins the behavior, and both packages are version-pinned in `package.json`. |
| The Approvals panel silently drifts from the gated tool list | Medium × Low | The panel runs the same `isGatedTool` predicate over the built-in names and registered user tools, so there is one source; a test asserts a user `sandbox-js` tool is gated and `make_dir`/`copy` are not. <!-- Updated: Red Team Session 1 - capability-based approval gating --> <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) --> |
| Denying a tool breaks a multi-step run that assumed success | Medium × Low | A denial is a normal structured result (`execution-denied`); the model sees it on the next step and can adapt, which is the point of the gate. |
| Mode confusion: the user believes `read_only` is active while a broader mode is set, or the converse | Medium × High | The mode is a visible composer control that reflects the active thread's persisted `mode`, and every mode change is either an explicit toggle or an accepted `change_mode` prompt, so a change is never silent. A test asserts the control reflects the thread's stored mode. <!-- Updated: Scope Addendum 1 - permission modes --> |
| `god` combined with a broad `allow` policy removes the consent step entirely | Medium × High | `god` auto-approves only the accept step: a persisted `deny` still blocks, and `change_mode` still asks. The mode is per-thread, user-visible, and `god` never writes a policy change, so leaving the mode restores asking. <!-- Updated: Scope Addendum 1 - permission modes --> |
| The model social-engineers a mode escalation through `change_mode` | Medium × High | `change_mode` always asks the user, names the requested target mode in the prompt, is never gated away and never auto-approved even in `god`, so the tool cannot raise its own ceiling; only an explicit user choice changes the mode. <!-- Updated: Scope Addendum 1 - permission modes --> |

**Rollback.** Set every gated tool's persisted decision to `allow` (a data change,
no deploy) or revert this phase's files. Reverting restores the ungated behavior and
leaves an `approvals` field in the vault that the old code ignores through
`deepMerge`; no thread format changes. Reverting the mode work removes the field with
no data migration, and any persisted thread containing a `mode` still loads because
the validator for that field reverts with the code (an old reader simply ignores it).
The spike report stays as a record.
<!-- Updated: Scope Addendum 1 - permission modes -->

## Security Considerations

- The policy lives only in the encrypted settings record, written through the vault
  write queue (`src/vault/store.ts:309`). No plaintext policy, tool name, or
  decision is written anywhere, proven by a byte-scan test.
- Gating `run_js` and `run_python` is a real control: it is the only barrier between
  a model-authored script and page-equivalent worker privileges. The default `ask`
  is deliberate. Because clause (b) keys on the user-tool kind, a user `sandbox-js`
  tool and an `http` tool are covered by the same barrier even though they are not
  named.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- `expireApprovals` and the in-session stale-approval rejection together prevent an
  old approval from being answered and resumed against a stream or a turn sequence
  that no longer exists.
- A denial must not leak information: the denial result carries the approval reason
  the user typed, or a fixed string, never the tool's intended payload beyond the
  input the model already supplied.
- The approval response travels from the URL-scoped, same-origin UI into the engine
  in memory only. No approval state is sent to a third party; the tool input that
  the model already produced is what is re-sent to the provider.
- No new worker message kind is introduced, so the `CryptoKey` boundary is
  unchanged.
- Permission modes narrow or widen consent but never bypass it: a persisted `deny`
  beats `god`, and `change_mode` always asks, so the model cannot raise its own
  ceiling without an explicit user action. The mode is stored on the encrypted thread
  record, not in plaintext.
  <!-- Updated: Scope Addendum 1 - permission modes -->

## Next Steps

Phase 5 changes only the system prompt and adds a `load_skill` tool. It must not
change the tool count in a way that re-triggers approval behavior accidentally;
`load_skill` is not gated because it is not in the named destructive list and is not
a user `sandbox-js`/`http` tool.
<!-- Updated: Red Team Session 1 - capability-based approval gating -->
<!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->

The mode ceiling does not change Phase 5 or Phase 6: `load_skill` and `update_plan`
are inside the `read_only` set, so they are permitted in every mode. Phase 6 carries
the mode round-trip into its whole-suite verification alongside the plan round-trip.
<!-- Updated: Scope Addendum 1 - permission modes -->
