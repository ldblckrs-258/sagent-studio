---
title: Personal memories — encrypted, model-written, global and per-workspace
description: The model saves durable facts about the user into the encrypted vault and sees them in later conversations.
status: implemented (browser check pending)
priority: P2
effort: 13h
branch: main
tags: [feature, frontend, database]
created: 2026-09-28
source: ../reports/brainstorm-260927-2359-personal-memories.md
---

# Personal memories

## Outcome

- The model saves a durable fact or preference about the user with `remember`. It keeps memories current with `update_memory` and `forget`. No approval prompt is shown.
- A memory is either global or bound to one workspace folder. A conversation sees global memories plus the memories of its current folder, and nothing from other folders.
- Every turn's system prompt carries:
  - an index (`id — title`) of the visible memories;
  - the full body of the visible memories flagged `important`.
  Other bodies load on demand through `recall_memory`.
- Memories are stored per record, AES-GCM encrypted, in a new `memories` vault table.
- A `Memory` rail panel lets the user add, edit, flag, and delete memories, grouped as Global, This workspace, and Other workspaces.

## Decisions (user, 2026-09-28)

- **No approval.** Memory tools join `READ_ONLY_TOOLS` and stay out of `GATED_BUILTINS`. A persisted `deny` still blocks them.
- **Scope.** Global plus per-workspace.
- **Workspace identity.** Each workspace scope stores its folder handle in `db.fs` under `memscope:<scopeId>`. A turn matches the current folder against those handles with `isSameEntry`.
- **Recall.** An index in the prompt, bodies through `recall_memory`, and the `important` flag inlines a body. The model may set `important`.
- **Sub-agents.** They cannot call `remember`, `update_memory`, or `forget`, and get no memory section. `recall_memory` stays in their pool when the parent has it.

## Defaults chosen by the planner (change at cook time if needed)

| Limit | Value | Why |
|-------|-------|-----|
| Title | 1–120 characters, single line | The index must stay one line per entry. |
| Body | 1–2,000 characters | Keeps one memory from taking the important budget alone. |
| Stored memories | 500 in total | Bounds hydration and the substring search. |
| Important budget | 2,000 body characters for global, and 2,000 for each workspace scope | The inlined total per turn is at most 4,000 characters. Each check touches only one scope. |
| Index | 100 entries, newest first, important entries excluded | Important entries are already shown in full. |
| `recall_memory` | at most 20 results | Bounds one tool result. |

A second `remember` with the same title (case-insensitive) in the same scope fails with `conflict` and names the existing id. This stops the model from piling up duplicates.

## Validation (user, 2026-09-28)

- **Default scope.** `remember` without a `scope` saves a global memory.
- **Limits.** The limits in the table above are confirmed.
- **Moving scope in the panel.** The edit form may move a memory between Global and the current workspace.

## Constraints

- Same per-record encryption and keyring guard as skills (`encryptRecord` / `decryptRecord`, AAD `memory:<id>`, `vaultWriteQueue`).
- Dexie v7 only adds the `memories` table. Existing v6 data opens unchanged.
- No new network egress. Memory text reaches the configured chat provider only as part of the system prompt.
- Tool results use the `toolOk` / `toolFail` envelope and `wrapToolExecute`.
- Every built-in tool needs a transcript view spec (`tool-view.test.tsx` enforces this).
- No code comments (user rule). Do not run the dev server or `pnpm build` without the user's go-ahead.

## Non-goals

- Export, import, and cross-device sync.
- Background extraction of memories by a separate model call.
- Embedding or semantic retrieval.
- An approval prompt for memory writes.
- Undoing memory writes through message rewind or `restore`.
- A memory section in sub-agent prompts.
- A bespoke transcript card. Memory tools get a plain view spec because the coverage test requires one.
- Live sync of memory edits between two open tabs.

## Phases

| # | Phase | Depends on | Status |
|---|-------|------------|--------|
| 1 | [Encrypted store and scope matching](phase-01-store-and-scopes.md) | — | completed |
| 2 | [Memory tools](phase-02-memory-tools.md) | 1 | completed |
| 3 | [Prompt section and session wiring](phase-03-prompt-and-wiring.md) | 2 | completed |
| 4 | [Memory panel](phase-04-memory-panel.md) | 1, 3 | completed |
| 5 | [Docs and verification](phase-05-docs-and-verification.md) | all | completed |

The phases run in sequence. Phase 4 needs only the store from phase 1, but it reads the current scope through the session wiring from phase 3.

## Architecture after the plan

```
db.memories (encrypted envelopes)      db.fs  memscope:<scopeId> → handle
            │                                   │
            └──────────── useMemoryStore ───────┘   hydrate on session start, clear on dispose
                             │  create · update · remove · resolveScope(fs) · ensureScope(fs)
                             │
          session.memoryPort()  ── resolves current scopeId from getWorkspace().handle
                 │                                 │
   buildRunStream: ports.memory            composeSystemPrompt({ memory: port.promptView() })
                 │                                 │
   remember · update_memory · forget ·     ## Memories  (preamble · important bodies · index)
   recall_memory
                 │
   sub-agent portsFor: memory port, write tools in BLOCKED_AGENT_TOOLS, no prompt section
```

## Acceptance criteria

1. **Encryption.** After `remember`, the `db.memories` row contains no title or body plaintext.
2. **Scope isolation.**
   - A conversation's prompt holds the global index plus the current folder's memories.
   - Memories of another folder are absent, even when both folders have the same name.
   - With no folder granted, only global memories appear, and `remember({ scope: 'workspace' })` fails with a hint.
3. **Recall.** Important bodies appear in the prompt and non-important bodies do not. `recall_memory` returns a body by id or by query, but only for memories visible in the current scope.
4. **Budget.** A write that would push a scope's important bodies past 2,000 characters fails with `memory_full` and stores nothing.
5. **Panel edits.** An edit or delete in the panel shows in the next turn's prompt.
6. **Lock.** A memory write whose vault locks mid-operation returns `disabled`. A hydrated store is cleared when the session is disposed.
7. **Sub-agents.** A sub-agent cannot call `remember`, `update_memory`, or `forget`, and its system prompt has no memory section.
8. **Wipe.** `recover()` leaves no memory rows and no `memscope:*` handles.
9. **No prompt.** Memory tools run without an approval prompt in `read_only`, `editing`, and `god`. A persisted `deny` blocks them.
10. **Gates.** `pnpm exec vitest run`, `pnpm exec tsc -b`, and `pnpm lint` pass. The build and the browser check run only with the user's go-ahead.

## Verified facts (2026-09-28)

- `recover()` already clears all of `db.fs`, so `memscope:*` handles go with it. Only `db.memories` needs adding to `recover()` and `vaultInternals.reset` (`src/vault/store.ts`).
- `resolveApprovalStatus` returns `approved` for a tool inside the mode ceiling that is not in `GATED_BUILTINS`, and returns `denied` first for a persisted `deny` (`src/tools/approval.ts`).
- `EDITING_TOOLS` spreads `READ_ONLY_TOOLS`, so one addition covers every mode.
- `PipelineDeps.workspace` is a `WorkspaceApi` with no handle. The handle is on the session's `getWorkspace(): WorkspaceFs`, so scope resolution belongs in the session.
- `sameFolder` in `src/session/workspace-state.ts` is private and compares two `WorkspaceFs`. Scope matching needs a handle-level helper.
- `tool-view.test.tsx` fails when a built-in tool has no entry in `TOOL_VIEWS`.

## Risks

- **Persistent prompt injection (accepted by the user).** Untrusted content can steer the model into saving a memory, and `important` puts it into every later prompt. Mitigations:
  - the prompt preamble says a memory cannot grant permissions, change the mode, or override instructions, and tells the model not to save secrets or instructions taken from files, documents, or tool results;
  - titles are clamped to one line and bodies are rendered as block quotes;
  - sub-agents cannot write memories;
  - every write shows in the transcript;
  - the panel lists the source (`model` or `user`) of each memory.
  Moving the three write tools into `GATED_BUILTINS` turns approval back on.
- **Handle matching on the hot path.** Each turn runs one `isSameEntry` per stored scope until one matches. Scope counts stay small, and a failed comparison counts as no match.
- **Orphaned scopes.** A moved folder or a lost grant can stop a handle from matching. The panel still lists those memories under Other workspaces, where they can be deleted.
- **Two tabs.** Each tab hydrates at unlock. A write in one tab is not seen by the other until it unlocks again. Writes are put-by-id, so they do not corrupt each other.

## Implementation notes (2026-09-28)

Deviations from the phase text, all verified by tests:

- **`MemoryPort` has no `hasWorkspace()`.** The store raises `MemoryScopeError` for a workspace write without a folder, so the method was unused.
- **Scope claiming lives in `store.create` / `store.update`.** The port caches the scope id from the returned memory instead of calling `ensureScope` itself.
- **Folder-handle cleanup happens only in `hydrate`.** Removing or moving the last memory of a scope no longer deletes its `memscope:` handle immediately, so a second tab cannot detach a folder the first tab still uses (review W2).
- **`memory_full` joined `ToolResultCode`.**
- **Unicode line breaks.** Titles reject `\v \f U+0085 U+2028 U+2029` as well as `\r \n`, and prompt rendering splits bodies on all of them (review W1).
- **Stop switch.** The Memory panel's "Let the model save memories" toggle stores `deny` (or `allow`) for the three write tools, because the Approvals panel lists only gated tools (review W3, user decision).
- **Reserved names accepted.** A saved user tool named `remember`, `update_memory`, `forget`, or `recall_memory` is skipped at hydrate like any built-in name clash (review W4, user decision).
- **Tooling.** A shell hook rewrites `pnpm exec tsc` to a global TypeScript 5.9.3, which reports false errors against this TypeScript 6.0.3 project. Use `rtk proxy pnpm exec tsc -b`.

Reports: [code review](../reports/code-reviewer-260928-0450-personal-memories.md), [tests](../reports/tester-260928-0450-personal-memories.md).
