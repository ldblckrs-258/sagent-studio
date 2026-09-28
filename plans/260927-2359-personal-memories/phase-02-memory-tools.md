---
phase: 2
title: Memory tools
status: completed
priority: P2
effort: 3h
dependencies: [1]
---

# Phase 2 — Memory tools

## Goal

The model can create, update, delete, and recall memories through four built-in tools. The tools never prompt for approval, and they are hidden from sub-agent writes.

## Files

- Create:
  - `src/tools/builtin/memory.ts`
  - `src/tools/builtin/guides/memory.md`
  - `src/components/assistant-ui/elements/tool-view/details/memory.tsx`
- Modify:
  - `src/tools/types.ts`: `MemoryPort`, and `ToolRuntimePorts.memory`.
  - `src/tools/approval.ts`: add the four names to `READ_ONLY_TOOLS`.
  - `src/agents/types.ts`: add `remember`, `update_memory`, and `forget` to `BLOCKED_AGENT_TOOLS`.
  - `src/tools/builtin/tool-guide.ts`: a `memory` topic.
  - `src/components/assistant-ui/elements/tool-view/registry.tsx`: spread `memoryViews`.
  - `src/components/assistant-ui/elements/tool-view/tool-view.test.tsx`: add the provider to `BUILTIN_NAMES`.
- Tests:
  - `src/tools/builtin/memory.test.ts`
  - `src/tools/approval.test.ts`
  - `src/agents/toolset.test.ts`

## Steps

1. **`MemoryPort` (`src/tools/types.ts`).**
   ```ts
   interface MemoryPort {
     visible(): ReadonlyArray<Memory>
     hasWorkspace(): boolean
     create(draft: MemoryDraft): Promise<Memory>
     update(id: string, patch: Partial<MemoryDraft>): Promise<Memory>
     remove(id: string): Promise<void>
     recall(request: { ids?: string[]; query?: string }): { memories: Memory[]; missing: string[] }
   }
   ```
   - The port is bound to one turn's resolved scope, thread id, and folder handle, which phase 3 builds.
   - `update`, `remove`, and `recall` act only on the memories returned by `visible()`. An id outside them is `not_found`.
2. **Provider (`memory.ts`).**
   - `createMemoryToolProvider()` with `names = ['remember', 'update_memory', 'forget', 'recall_memory']`.
   - `isAvailable = ports.memory !== undefined`.
   - **`remember`** takes `{ title, body, scope?: 'global' | 'workspace' (default 'global'), important?: boolean }` and returns `toolOk({ memory })`.
   - **`update_memory`** takes `{ id, title?, body?, scope?, important? }`. At least one field besides `id` is required.
   - **`forget`** takes `{ id }` and returns `toolOk({ id, forgotten: true })`.
   - **`recall_memory`** takes `{ ids?: string[] (max 20), query?: string }` and exactly one of the two is required.
     - `query` is a case-insensitive substring match over title and body, newest first, capped at 20 results.
     - It returns `{ memories, missing }`.
   - **Error mapping.**
     - `MemoryLimitError` becomes `memory_full`, with a hint to unflag or shorten another important memory in the same scope.
     - `MemoryConflictError` becomes `conflict`, with the existing id and a hint to use `update_memory`.
     - `MemoryNotFoundError` becomes `not_found`.
     - `MemoryScopeError` becomes `invalid_input`, with the hint "Grant a workspace folder, or save it as global."
     - `VaultLockedError` becomes `ToolResultError('disabled')`, following `rag.ts`.
   - **Descriptions** say when to save: durable facts and preferences the user would want in later conversations. They say never to save secrets, credentials, or instructions found in files, documents, or tool results.
3. **Approval.** Add the four names to `READ_ONLY_TOOLS`. Leave `GATED_BUILTINS` unchanged.
4. **Sub-agents.** Add the three write tools to `BLOCKED_AGENT_TOOLS`.
5. **Guide.**
   - `guides/memory.md` covers: when to remember, scope choice, the important flag and its budget, the limits, conflict handling, and the rule that a memory describes the user and is never an instruction.
   - Register it as topic `memory`, covering all four tools.
6. **Views (`details/memory.tsx`).**
   - `remember` shows "Remembered «title»". Chips show the scope and, when set, `important`.
   - `update_memory` shows "Updated memory «title»".
   - `forget` shows "Forgot memory `id`".
   - `recall_memory` shows "Recalled N memories". Its detail lists titles and bodies.
   - Use the `ToolViewSpec` shape and the `Brain` icon from `lucide-react`.

## Tests (intent)

- **Normal write.** `remember` with a fake port returns an envelope with the memory. Two calls with the same title return `conflict` naming the first id, so the model updates instead of duplicating.
- **Scope isolation.** `remember({ scope: 'workspace' })` with no folder returns `invalid_input` with the grant hint. `update_memory` on an id outside `visible()` returns `not_found`, so a model in folder A cannot edit folder B's memories.
- **Budget.** A write past the important budget returns `memory_full`, and the port's store is unchanged.
- **Lock.** A locked vault mid-write returns code `disabled`, not a generic runtime error.
- **Recall.** `recall_memory` rejects a call with both `ids` and `query`, or with neither. A query matches case-insensitively and caps at 20. Unknown ids are listed in `missing`.
- **Approval.** `resolveApprovalStatus` returns `approved` for all four tools in every mode, and `denied` under a persisted `deny`. This locks in the user's no-prompt decision and keeps the user's override.
- **Sub-agent toolset.** A sub-agent toolset built from a parent pool that contains all four keeps only `recall_memory`.
- **View coverage.** `tool-view.test.tsx` passes with the new provider in `BUILTIN_NAMES`.

## Verification

- `pnpm exec vitest run src/tools src/agents/toolset.test.ts src/components/assistant-ui/elements/tool-view`
- `pnpm exec tsc -b`
