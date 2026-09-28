---
title: Planned personal memories
date: 2026-09-27
summary: "Brainstormed and planned model-written, encrypted, global and per-workspace memories; no code changed."
---

# Planned personal memories

## What happened

- Brainstormed and planned a personal memories feature for the harness. No code changed.
- Scouting found no existing memory surface. The pieces to reuse:
  - per-record vault encryption (`encryptRecord`, following `src/skills/store.ts`);
  - `composeSystemPrompt` in `src/chat/context.ts`;
  - the approval ceilings in `src/tools/approval.ts`;
  - `BLOCKED_AGENT_TOOLS` for sub-agents;
  - the private `sameFolder` / `isSameEntry` comparison in `src/session/workspace-state.ts`.
- The repo has no stable workspace id. Each thread stores its own handle under `thread:<id>`, and conversations group by folder name.
- `tool-view.test.tsx` fails for any built-in tool without a `TOOL_VIEWS` entry. The memory tools therefore need a view spec, even though a bespoke card is a non-goal.

## Decision

- **Writes.** The model writes memories without approval: the tools go in `READ_ONLY_TOOLS`, not `GATED_BUILTINS`, and a persisted `deny` still blocks them.
- **Scope.** Global plus per-workspace. A workspace is identified by a folder handle stored in `db.fs` under `memscope:<scopeId>` and matched with `isSameEntry`.
- **Recall.**
  - The prompt carries an index of the visible memories.
  - `recall_memory` loads bodies on demand.
  - The `important` flag inlines a body, capped at 2,000 characters per scope, so at most 4,000 characters are injected per turn.
- **Sub-agents.** They cannot write memories and get no memory section.
- **Defaults.** `remember` defaults to the global scope, and the panel may move a memory between Global and the current workspace.
- **Accepted risk.** Persistent prompt injection. The mitigations are a prompt preamble, single-line titles, block-quoted bodies, blocked sub-agent writes, a visible source chip, and a transcript card.

## Next steps

- `/ak:cook plans/260927-2359-personal-memories/plan.md`. The five phases run in sequence: store and scopes, tools, prompt and wiring, panel, then docs and verification.
- Brainstorm: `plans/reports/brainstorm-260927-2359-personal-memories.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
