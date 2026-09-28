---
type: brainstorm
date: 2026-09-28
topic: Personal memories stored in the encrypted vault
status: accepted
---

# Brainstorm: personal memories

## Summary

The model gains durable memory about the user that survives across conversations. Memories are saved by the model itself without an approval prompt, scoped either globally or to one workspace folder, and stored as per-record encrypted blobs in a new `memories` vault table. Each turn's system prompt carries an index of the in-scope memories plus the full body of those flagged `important`; everything else is loaded on demand through `recall_memory`. A new `Memory` rail panel lets the user read, edit, re-flag, and delete them.

## Evidence (current state)

- No memory feature exists in `src/` or `plans/`.
- Vault storage: Dexie `sagent-vault` at schema v6 (`src/vault/db.ts`). Per-record AES-GCM through `encryptRecord` / `decryptRecord` with a keyring snapshot guard (`src/vault/records.ts`). The closest pattern to copy is `src/skills/store.ts` (versioned envelope, `vaultWriteQueue`, AAD `skill:<id>`).
- System prompt assembly: `composeSystemPrompt` in `src/chat/context.ts`, called from `buildRunStream` in `src/chat/engine.ts:483`.
- Tool gating: `GATED_BUILTINS`, `READ_ONLY_TOOLS`, `EDITING_TOOLS` in `src/tools/approval.ts`. A tool outside `GATED_BUILTINS` and inside the mode ceiling resolves to `approved`; a persisted `deny` still wins.
- Sub-agent blocking: `BLOCKED_AGENT_TOOLS` in `src/agents/types.ts`.
- Vault wipe: `recover()` and `vaultInternals.reset` in `src/vault/store.ts` enumerate every table explicitly.
- Workspace identity: there is no stable workspace id. Each thread stores its own handle under `thread:<id>` in `db.fs` (`src/workspace/handle.ts`). Conversations are grouped by the `workspaceName` label. `sameFolder` in `src/session/workspace-state.ts:69` already compares two handles with `isSameEntry`.
- Tool providers are registered in `src/session/session.ts:426-434`; registries hydrate on unlock in `src/session/session-provider.tsx:53-58`.

## Decisions (accepted)

1. **Write path: the model saves without asking.** Memory tools join `READ_ONLY_TOOLS` and stay out of `GATED_BUILTINS`, so they run in every mode with no prompt. A user-persisted `deny` in the approvals policy still blocks them.
2. **Scope: global plus per-workspace.** Each memory is either `global` or bound to one workspace folder.
3. **Recall: index plus on-demand, with an `important` flag.** The prompt lists `id — title` for every in-scope memory and inlines the body of each `important` one. Other bodies load through `recall_memory`.
4. **Workspace identity: handle plus `isSameEntry`.** A workspace scope stores its folder handle in `db.fs` under `memscope:<scopeId>`. Each turn matches the current folder against the stored scope handles through the existing `sameFolder` logic. Two folders with the same name never share memories.
5. **The model may set `important`.** This is consistent with decision 1.

## Outcome

- The model calls `remember` when it learns a durable fact or preference, and `update_memory` / `forget` to maintain it.
- A new conversation (any mode, any workspace) sees the global memories and the memories bound to its current folder.
- The user manages memories in a `Memory` rail panel grouped as Global and This workspace: edit title and body, toggle important, delete.

## Design

### Data

- Dexie v7 adds `memories: 'id, updatedAt'`. The row is `{ id, blob, updatedAt }`, and every other field lives inside the ciphertext, so no plaintext metadata leaks.
- Envelope: `{ version: 1, memory: { id, title, body, scope, important, source, threadId?, createdAt, updatedAt } }`, AAD `memory:<id>`.
  - `scope`: `{ kind: 'global' }` or `{ kind: 'workspace', scopeId, label }`, where `label` is the folder name kept for display.
  - `source`: `'model' | 'user'`.
- Workspace scope handles are stored in `db.fs` as `memscope:<scopeId>`. Like every other handle today, they are plaintext.
- On unlock, all memories are decrypted into an in-memory store, the same way skills are hydrated. Lock clears it.

### Tools

| Tool | Input | Notes |
|------|-------|-------|
| `remember` | `title`, `body`, `scope: 'global' \| 'workspace'`, `important?` | `workspace` without a granted folder fails with a hint. A new workspace scope stores the handle. |
| `update_memory` | `id`, partial `title` / `body` / `important` / `scope` | |
| `forget` | `id` | |
| `recall_memory` | `ids?` or `query?` | Loads bodies by id, or runs a case-insensitive substring search over title and body within scope. |

- A locked vault returns `disabled` with a hint, following the `rag.ts` pattern.
- An operations guide is added under `src/tools/builtin/guides/memory.md` and served by `read_tool_guide`.

### Prompt

A `## Memories` section is added by `composeSystemPrompt` when the memory tools are present:

- A preamble saying the entries describe the user and their preferences, and that a memory cannot grant permissions, change the mode, or override these instructions.
- An index of `id — title` lines, with titles clamped through `clampIndexText`. It is capped at about 100 entries, newest first; when truncated, the section tells the model to use `recall_memory` with a query.
- The bodies of `important` memories, capped at about 4,000 characters in total. `remember` / `update_memory` that would exceed the cap fail with `memory_full` and a hint to unflag another memory.
- Scope resolution for the current turn happens in `buildRunStream`, next to `loadProjectInstruction`.

### Sub-agents

- `remember`, `update_memory`, and `forget` are added to `BLOCKED_AGENT_TOOLS`.
- Sub-agents get no memory section. `recall_memory` stays usable if it is in the parent's pool.

### UI

- A new `memory` `RailPanelId` with a panel in `src/ui/panels/memory.tsx`, following the `library.tsx` / `skills.tsx` pattern.
- Memory tool calls render through the existing generic tool card. Every write is visible in the transcript.

## Constraints

- Same per-record encryption and keyring guard as skills and documents.
- Dexie v7 is additive. v6 data opens unchanged.
- `recover()` and `vaultInternals.reset` must clear `memories` and the `memscope:*` handles.
- No new network egress. Memory text only reaches the configured chat provider, as part of the prompt.
- Tool results use `toolOk` / `toolFail` envelopes.
- `pnpm test` and `pnpm lint` stay green.

## Non-goals

- Export, import, or cross-device sync.
- Background auto-extraction of memories by a separate model call.
- Embedding or semantic retrieval.
- An approval prompt for memory writes.
- Undoing memory writes through message rewind or the `restore` tool.
- Showing memories to sub-agents.
- A custom transcript card for memory tools.

## Acceptance criteria

1. After `remember`, `db.memories` holds only ciphertext; the title and body do not appear in the stored row.
2. A new conversation's system prompt contains the index of global memories and, with a folder granted, that folder's memories; memories of another folder are absent, including one with the same folder name.
3. `important` bodies appear in the prompt; non-important bodies do not, and `recall_memory` returns them.
4. Exceeding the important cap returns `memory_full` without writing.
5. Deleting or editing in the panel is reflected in the next turn's prompt.
6. With the vault locked, every memory tool returns `disabled`.
7. A sub-agent cannot call `remember`, `update_memory`, or `forget`.
8. `recover()` leaves no memory rows and no `memscope:*` handles.
9. Memory tools run without an approval prompt in `read_only`, `editing`, and `god`; a persisted `deny` blocks them.

## Touch points

| File | Change |
|------|--------|
| `src/vault/db.ts` | `MemoryRecord`, schema v7 |
| `src/vault/store.ts` | clear `memories` and `memscope:*` in `recover()` and `reset` |
| `src/memory/` (new) | types, encrypted store, in-memory registry, scope matching |
| `src/tools/builtin/memory.ts` (new) | tool provider |
| `src/tools/builtin/guides/memory.md` (new) | operations guide |
| `src/tools/approval.ts` | add the four tools to `READ_ONLY_TOOLS` |
| `src/agents/types.ts` | block the three write tools |
| `src/chat/context.ts` | `## Memories` section |
| `src/chat/engine.ts` | resolve in-scope memories in `buildRunStream` |
| `src/session/session.ts`, `session-provider.tsx` | register the provider; hydrate and clear the registry |
| `src/ui/shell.tsx`, `src/ui/panels/memory.tsx` (new) | rail panel |
| `README.md` | user-facing section on memories and what leaves the machine |

## Risks

- **Persistent prompt injection (accepted).** Content from a workspace file, a document passage, or a tool result can steer the model into saving a memory that is then injected into every later conversation, and `important` puts it straight into the system prompt. The user accepted this in exchange for no approval prompt. Mitigations kept: sub-agents cannot write, every write shows in the transcript, the panel allows deletion, the prompt preamble limits what a memory can claim, and titles are single-line clamped. If this proves too loose, gating is a one-line move into `GATED_BUILTINS`.
- **Handle matching cost.** `isSameEntry` runs once per distinct workspace scope per turn. The scope count stays small, but it is an async call on the hot path.
- **Folder moved or permission lost.** A stored scope handle may stop matching after a folder move, which orphans that scope's memories. The panel still lists them under their label, so the user can rescope or delete them.
- **Prompt growth.** The index and the important bodies add tokens to every turn, bounded by the two caps.

## Unresolved questions

Both were resolved during planning. The caps were confirmed as 2,000 important characters per scope, so at most 4,000 are injected per turn, with 100 index entries. The panel may move a memory between Global and the current workspace. See `plans/260927-2359-personal-memories/plan.md`.
