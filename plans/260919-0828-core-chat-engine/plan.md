---
title: "Core Chat Engine"
description: "UI-agnostic chat core with configurable instruction/params, history editing, skill injection, local-folder tools, and sandboxed JS/Python runners"
status: implemented
priority: P1
effort: 54h
branch: main
tags: [feature, frontend, ai, infra, security]
blockedBy: []
blocks: []
created: 2026-09-19
---

# Core Chat Engine

## Overview

Build the execution logic for chatting with an LLM, with no UI in scope. The
engine owns an app-controlled `UIMessage[]` history and exposes: configurable
system instruction and model parameters per thread, streaming turns, undo/rerun,
editing messages on both sides, skill injection, and model-callable tools backed
by a user-granted local folder and a sandboxed JS/Python code runner.

This builds on the frozen interfaces from
[Core Infrastructure + Encrypted Vault](../260918-1209-core-infra-vault/plan.md):
`createLLM(settings, providerId, modelOverride?)`, the vault unlock lifecycle, and
the encrypted settings store. Threads, skills, and user tool definitions persist
inside the same encrypted vault.

Source of truth for the contract, evidence, and approach comparison:
[brainstorm report](./reports/brainstorm-260919-0828-core-chat-engine.md).
Runtime research: [browser runtime](./reports/researcher-01-browser-runtime.md),
[AI SDK + assistant-ui](./reports/researcher-02-ai-sdk-assistant-ui.md).
Red-team review findings and dispositions are recorded below.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Chat with a configured provider using a configurable system instruction and model parameters | P1 |
| 2 | Deterministic undo, rerun, and message editing on both user and assistant sides | P1 |
| 3 | Inject skills (SKILL.md bundles) into the prompt and register their tools | P1 |
| 4 | Read/write files in a user-granted local folder via system tools | P1 |
| 5 | Run JavaScript and Python in isolated workers | P1 |
| 6 | Let users import and edit skills and tools, persisted encrypted | P1 |

## Contract

**Outcome.** An engine module set (`src/chat`, `src/skills`, `src/tools`,
`src/workspace`, `src/sandbox`) that drives a streaming, tool-using chat over the
existing provider factories, with per-thread configuration, editable history, and
encrypted persistence. No React components are added.

**Constraints.**

- Browser-only, matching the existing vault/Dexie/WebCrypto architecture.
- The vault `CryptoKey` never enters a worker.
- The `FileSystemDirectoryHandle` **is** persisted in IndexedDB across reload by
  explicit user decision, accepting that a same-origin worker can read and use it.
  Path validation and permission re-checks still apply to the main-thread tools.
- File access is confined to the granted folder; traversal is rejected and
  permission is re-checked per operation.
- Core logic is testable under Vitest `environment: 'node'` by injecting fakes;
  worker lifecycle is driven through an injectable worker factory. Real-browser
  checks are recorded as a named, blocking artifact.
- No secrets in logs, errors, or persisted plaintext.

**Non-goals.**

- Chat UI and assistant-ui wiring (separate ticket).
- RAG ingestion, embeddings, and the TypeSafe checkpoints (Plan 2).
- Multi-device sync, accounts, sharing.
- Server-side or remote code execution; MCP client support.
- Neutralizing unbounded network egress from executed code (user-accepted residual
  risk).
- Neutralizing a sandbox worker that reads the persisted folder handle from
  IndexedDB (user-accepted residual risk).
- Firefox/Safari parity for folder tools (feature-detected, typed degradation).

**Acceptance criteria.**

1. `sendTurn` streams an assistant turn; the system instruction and thread model
   parameters (temperature, topP, maxOutputTokens, model id) reach the request,
   asserted with `MockLanguageModelV4`.
2. Undo removes the last turn; rerun of any assistant message regenerates from its
   parent user message without duplication; editing a user or assistant message
   deterministically truncates downstream history. Reducer tests include a middle
   assistant message.
3. Enabling a skill injects its instructions into the request `system` prompt and
   registers its declared tools with the model; disabling removes both.
4. Workspace tools list and read/write within the granted folder; a path with `..`,
   a backslash, or an absolute/UNC prefix is rejected with `WorkspacePathError`;
   the persisted handle is restored after reload and permission is re-requested.
5. `run_js` returns `{ stdout, stderr, result, error? }` from a worker and is
   force-terminated past its timeout with every pending `fs` RPC rejected;
   `run_python` does the same through Pyodide and can read/write workspace files
   only through the main-thread RPC bridge.
6. Users can import, edit, and remove skills and tools through the core API;
   changes persist encrypted and survive reload.
7. Threads and messages persist encrypted; a byte-scan test finds no plaintext
   message content or title in IndexedDB records; an aborted tool-using turn
   rehydrates into a thread that converts cleanly on the next run.
8. `pnpm lint`, `pnpm build`, and `pnpm test` pass.

## Key Decisions

- **Runtime spike first.** Phase 1 opens with a throwaway worker spike that
  confirms `eval`/`Function` and WASM run in a Vite-bundled worker under the
  strict document CSP, and that `Worker.terminate()` kills a running worker. If
  it fails, the CSP approach is re-planned with the user before any runner code.
- **Document CSP stays strict.** Per HTML §7.1.7 and WPT, a same-origin `http(s)`
  worker does not inherit the document CSP; its policy comes from its own response
  headers. The app has no server and injects CSP via `<meta>`, so a Vite-emitted
  worker chunk has no policy and can use `eval`/WASM without relaxing the document.
  `script-src 'self'` is kept. Only `worker-src 'self'` is added explicitly.
- **Accepted residual risk: worker network egress and handle reach.** A
  self-origin worker with no response-header CSP can `fetch` anywhere, and CSP does
  not block IndexedDB access. Model-authored code therefore has page-equivalent
  network reach. This is accepted because the key never enters the worker and code
  only sees explicit tool inputs. Deployment-level hardening (a worker-asset
  response header with `connect-src 'self'`) is documented as optional and
  host-dependent, not a gate.
- **Persisted folder handle (user-accepted risk).** `FileSystemDirectoryHandle` is
  stored in a dedicated Dexie table so the workspace survives reload, accepting that
  the sandbox worker can read and use it. Main-thread tools keep path validation and
  permission re-checks; the persisted handle is a documented residual risk, not a
  guarantee. User re-grants permission from a gesture after reload.
- **Encrypted per-record persistence, serialized.** `src/vault/records.ts` exposes
  `encryptRecord`/`decryptRecord` bound to the key and generation, with AAD per
  record. Record writes go through a vault write queue that `lock()`/`recover()`
  drain, so no write can land after lock. Thread saves are additionally serialized
  per thread id to prevent reorder data loss.
- **Single generation source.** `keyring.ts` owns key and generation as one atomic
  pair. `VaultState.unlockGeneration` becomes a projection updated with it.
- **Skill trust separation.** Workspace-sourced skills are untrusted: their
  instructions go into a delimited untrusted block, must be explicitly enabled by
  the user, and their `allowed-tools` can never exceed the user-enabled set.
- **User tool kinds: `sandbox-js` and `http`.** User-defined tools are
  `sandbox-js` definitions (schema plus source in the worker) or `http` definitions
  (declarative request template). HTTP tools are hardened: an explicit per-tool host
  allow-list, no interpolation into the URL authority or header names, a resolved
  URL origin check after substitution, and a response-size cap.
- **`ChatTransport` adapter included.** A thin `ChatTransport<UIMessage>` adapter is
  provided alongside the app-owned store, so the engine can also be driven by
  `useChat`/`@assistant-ui/ai-sdk` later. It returns the same
  `toUIMessageStream` output and `reconnectToStream` resolves `null`.
- **Pyodide self-hosted.** `pyodide` is copied to `public/pyodide/` at dev/build
  time and loaded in a module worker via `indexURL`; `Worker.terminate()` is the
  only timeout mechanism because `SharedArrayBuffer` is unavailable.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Runtime Spike and Chat Domain](./phase-01-runtime-spike-and-chat-domain.md) | Done |
| 2 | [Encrypted Thread Persistence](./phase-02-encrypted-thread-persistence.md) | Done |
| 3 | [Tool Registry and Skills](./phase-03-tool-registry-and-skills.md) | Done |
| 4 | [Workspace and File Tools](./phase-04-workspace-and-file-tools.md) | Done (picker/re-grant manual gate pending) |
| 5 | [Code Runners](./phase-05-code-runners.md) | Done |
| 6 | [Chat Engine](./phase-06-chat-engine.md) | Done (real-provider manual gate pending) |

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Blocked by | `project:260918-1209-core-infra-vault` | completed |

Consumed and extended interfaces:

- `createLLM(settings, providerId, modelOverride?) -> LanguageModel` (unchanged).
- `Settings` gains no new required fields; thread config is per-thread.
- New: `src/vault/records.ts` `encryptRecord`/`decryptRecord`, and a
  `src/vault/keyring.ts` that becomes the single source of key and generation.

## Success Criteria

- [x] Acceptance criteria 1, 2, 3, 5, 6, 7, 8 are evidenced by automated tests
      (268 passing); the browser-only checks for the worker spike and the
      sandbox runners are evidenced in the manual-validation journal entry.
- [ ] Criterion 4's reload + permission re-grant step is browser-only and not yet
      recorded: `showDirectoryPicker` needs a real user gesture and a native OS
      dialog that headless CDP cannot drive. Path validation, permission mapping,
      and read/write/remove are covered by `fake-handle` unit tests.
- [x] `pnpm lint`, `pnpm build`, and `pnpm test` pass; the full pre-existing suite
      is green (do not encode a test count).
- [x] No `CryptoKey` or `FileSystemDirectoryHandle` can be sent through the worker
      bridge, proven by a unit test; the persisted handle is a documented
      user-accepted residual risk.
- [x] The worker spike confirms eval/WASM/terminate behavior, recorded in
      `plans/journals/2026-09-19-implemented-core-chat-engine.md`.
- [x] Plan 1's frozen-interface note is updated for the additive
      `keyring`/`records` exports and the generation-source change.
- [x] `plans/README.md` indexes this plan.

## Manual Validation Artifact

Browser-only checks (worker spike, folder pick/read/write/re-grant, Pyodide
read/write, real provider turn) are recorded in
`plans/journals/2026-09-19-implemented-core-chat-engine.md` with date, build hash,
browser version, command, and observed result. Phase completion is contingent on
the relevant entries; "manual check" without this record does not satisfy a gate.

## Risk Summary

| Risk | Mitigation |
|------|------------|
| Same-origin worker CSP inheritance differs in a live browser | Phase 1 spike is a stop-the-line gate before runner code; re-plan with the user on failure. |
| Worker egress / IndexedDB reach can exfiltrate bridged data | Accepted, documented user decision; no key is reachable; only explicit tool inputs cross the bridge. |
| Persisted folder handle readable by the sandbox worker | Accepted, documented user decision; main-thread tools still validate paths and permission, but the worker can bypass them. |
| HTTP tool drives a main-thread request to an arbitrary host | Explicit per-tool host allow-list; no interpolation into authority or header names; resolved-origin check; response cap. |
| Key/generation desync or write-after-lock | Keyring owns key+generation atomically; record writes share a queue drained by lock/recover. |
| Concurrent thread saves reorder | Per-thread promise chain serializes saves. |
| Pyodide ~13 MB cold start and kill-then-reload cost | Lazy load on first `run_python`; warm worker; terminate only on timeout; document. |
| Workspace-skill prompt injection | Untrusted block + explicit enable + allowed-tools cap + tests. |
| Folder picker is Chromium-only | Feature detect; `WorkspaceUnsupportedError`; fallbacks documented, not built. |
| Runner lifecycle untestable in node | Injectable worker factory drives terminate/timeout/RPC-leak tests. |
| Refactoring the vault key into `keyring.ts` regresses the vault suite | Full vault suite is the gate; generation becomes a projection of keyring. |

## Red Team Review

Four hostile reviewers (Security Adversary, Assumption Destroyer, Failure Mode
Analyst, Scope & Complexity Critic) reviewed the plan against the installed
packages and the live code. AI SDK v7, assistant-ui, and CSP-spec claims were
independently re-verified as correct. Accepted findings and their resolutions:

**Critical**

1. A persisted `FileSystemDirectoryHandle` in the vault IndexedDB is readable and
   usable by the unrestricted sandbox worker, defeating the main-thread bridge.
   Resolution rejected by user decision: the handle **is** persisted for reload
   convenience and the residual risk is accepted and documented (Key Decisions,
   Non-goals). Main-thread path validation and per-op permission remain, but they
   do not constrain the worker.
2. Phase 5 runner lifecycle had no automated coverage and was gated only by an
   unversioned manual note. Resolution: an injectable worker factory with
   terminate/timeout/pending-RPC tests, plus a named blocking journal artifact.
3. Pending `fs.call` promises were never rejected on `terminate()`, leaking and
   hanging. Resolution: terminate rejects every pending RPC and disposes listeners.

**High**

4. Worker egress was demoted to an optional footnote despite the research naming
   it the core containment issue. Resolution: recorded as an explicit accepted
   risk in Key Decisions and surfaced to the user, with optional host hardening.
5. `rerun(threadId, messageId)` could not be expressed by `rerunBase(messages)`.
   Resolution: `baseForMessage(messages, id)` truncates through the parent user
   message; a middle-assistant-message test is required.
6. Aborting a tool-using turn persisted non-terminal tool parts, poisoning the next
   request; `UIMessage` has no `status` field. Resolution: persist partial status
   in `metadata`, drop/sanitize non-terminal tool parts on abort and on rehydrate,
   and pass `ignoreIncompleteToolCalls` to `convertToModelMessages`.
7. `records.ts` bypassed the vault write queue, allowing a write after lock, and
   `keyring` introduced a second generation counter. Resolution: shared vault
   write queue drained by lock/recover/reset; keyring is the single source and
   `unlockGeneration` is a projection.
8. Concurrent `saveThread` calls could reorder and lose the newest turn.
   Resolution: per-thread save chain.
9. Workspace-sourced SKILL.md instructions were concatenated as trusted system
   prompt. Resolution: untrusted delimited block, explicit enable, allowed-tools
   cap, tests.
10. Scope: `http` user tools and the `ChatTransport` adapter were flagged as
    unrequested. Resolution rejected by user decision: both are kept. HTTP tools
    carry the hardening from finding 4 (host allow-list, no authority/header
    interpolation, resolved-origin check, response cap); transport is a thin
    adapter with `reconnectToStream` resolving `null`.

**Medium**

11. `maxSteps` had no default; `streamText` defaults to one step, silently
    breaking tool turns. Resolution: `defaultThreadConfig` pins `maxSteps >= 4`
    with a test.
12. CSP spike could not fail because `pnpm preview` serves no worker response CSP.
    Resolution: the spike explicitly states `vite preview` is not a production-host
    proxy and records worker `fetch`/IndexedDB reach observations.
13. Interfaces were under-specified (`composeSystemPrompt` signature, engine method
    names, `SkillRef`, `CodeRunner` port). Resolution: Phase 1 freezes them.
14. `keyring` refactor and Plan 1 frozen interfaces needed an explicit note.
    Resolution: Plan 1 doc updated in Phase 2; `plans/README.md` updated in Phase 1.
15. Manual gates had no artifact. Resolution: named journal file in
    `## Manual Validation Artifact`.
16. Path hardening gaps (backslash, drive/UNC, per-op permission, TOCTOU) and a
    deny-list serializer. Resolution: allow-list serializer, inbound message
    validation, stricter path rejection, per-op permission check.

**Notes applied**

- The stale hard-coded "81 tests" anchor was removed; gates reference the full
  suite without a count.
- The AAD scheme has no rollback protection; recorded as an accepted limitation
  because a local attacker able to rewrite IndexedDB already holds broader power.
- The CSP spike must observe worker `fetch` and IndexedDB reach, not only eval/WASM.

### Whole-Plan Consistency Sweep

Phase 1 carries the spike and freezes `CodeRunner`, `SkillRef`,
`composeSystemPrompt`, the engine method table, and error names. Phases 2-6
reference those definitions rather than re-deriving them. `http` tools and the
`ChatTransport` adapter are present in Phase 3 and Phase 6 respectively, matching
the user's validation decisions. The workspace handle is described as persisted in
a Dexie `fs` table everywhere, with the residual risk noted. Record persistence is
described as queue-serialized everywhere. The phase table, acceptance criteria,
and risk summary match the phase files.

## Validation Log

### Validation Session 1 — 2026-09-19

Questions asked: 3 (worker egress, handle persistence, scope cuts).

| # | Question | Decision |
|---|----------|----------|
| 1 | Worker network egress / IndexedDB reach | **Accept and document** the residual risk. Worker has page-equivalent network reach; key never enters the worker; only explicit tool inputs cross the bridge. Optional host response-header CSP remains documented, not a gate. |
| 2 | Persist the folder handle across reload | **Persist** in a Dexie `fs` table. User accepts that the sandbox worker can read and use the handle and bypass main-thread path policy. |
| 3 | Cut `http` user tools and `ChatTransport` adapter | **Keep both.** HTTP tools must carry host allow-list, no authority/header interpolation, resolved-origin check, and a response cap. Transport is a thin adapter with `reconnectToStream -> null`. |

Propagation: Phase 3 re-adds the `http` tool kind and `src/tools/http.ts` with
hardening; Phase 4 persists the handle (Dexie version 4 `fs` table) and documents
the accepted risk; Phase 6 re-adds `src/chat/transport.ts`; `plan.md` constraints,
non-goals, key decisions, acceptance criteria, and risk summary updated.

### Whole-Plan Consistency Sweep

Re-read `plan.md` and every `phase-*.md` after propagation. No remaining reference
to a session-only handle, to a removed `http` kind, or to a removed transport.
`http` hardening requirements appear in both Phase 3 and the plan risk summary.
The handle residual risk appears in `plan.md` and Phase 4 consistently.

## Implementation Log

### 2026-09-19 — implemented

All six phases are implemented. `pnpm test` (268 tests, 28 files), `pnpm lint`,
and `pnpm build` are green; the built CSP carries `worker-src 'self'` and no
`'unsafe-eval'`; `yaml` bundles with no Node shim.

Evidence and browser runs: [`journals/2026-09-19-implemented-core-chat-engine.md`](../journals/2026-09-19-implemented-core-chat-engine.md).
It records the Phase 1 worker CSP/eval/WASM/terminate spike and the Phase 5
JS/Python runner, timeout, and workspace-bridge runs against a built `vite
preview`.

An independent review found one high-severity defect and three medium findings;
all were fixed with regression tests:

1. A pre-stream failure left an orphaned empty assistant message that later turns
   persisted (thread poisoning). Fixed by restoring the base history and
   persisting before rethrowing.
2. `PyRunner` was unsafe for concurrent runs; runs are now serialized.
3. `providerOptions` was validated but not forwarded; it now reaches `streamText`.
4. One malformed workspace `SKILL.md` aborted the whole listing; it is now skipped.

Also added: `ToolRegistry.hydrate`, stricter persisted http-definition validation,
and an end-to-end assertion that the model id and provider options reach the model.

Two manual gates remain unverified in this environment and are not claimed as
met:

- **Phase 4 picker + reload re-grant.** `showDirectoryPicker` requires a real user
  gesture and a native OS dialog; headless CDP cannot drive it. Unit coverage uses
  `fake-handle`.
- **Phase 6 real-provider turn.** No live provider API key is available.

### Whole-Plan Consistency Sweep (implementation)

Every phase file is marked `done` and its Todo is checked. The two unverified
manual gates are called out in the phase table, the Success Criteria, and the
journal, and are the only items not evidenced. The rest of the plan's claims match
the code and tests.
