---
title: Sub-agent delegation plan
date: 2026-09-22
summary: "Brainstorm + red-teamed plan for delegated sub-agents, tiered models, last-used model"
---

# Sub-agent delegation plan

## Context

Brainstormed a sub-agent delegation feature for sagent-studio and produced a
six-phase plan at `plans/260922-1354-sub-agent-delegation`. The user clarified
that the `subModel` -> cheap-tier migration is a plan task, not a request to
implement now; an early attempt to edit `src/vault/settings.ts` was reverted.

## Decisions

- Sub-agent tool `spawn_agent`: prompt, mode (<= parent), optional tier, skills,
  excludeTools, background; one level deep.
- Four tiers `cheap|medium|high|max` shown as Spark / Forge / Prime / Oracle;
  legacy `subModel` migrates into `cheap`.
- Delegated approvals: Allow/Deny only, never persisted, pause-and-queue.
- Runs persist as child agent threads; background completion appends one notice.
- Last-used model persisted; new conversations seed from it.

## Red team

Four hostile lenses found 24 issues. Two were showstoppers: `spawn_agent`
availability was circular (port needed tool names, names came after the toolset)
and detached runs had no lifecycle owner. Also rewrote approval to use the SDK's
async `toolApproval` instead of wrapping tool `execute`, after confirming
`SingleToolApprovalFunction` returns `MaybePromiseLike` in `ai@7`.
</EOF

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
