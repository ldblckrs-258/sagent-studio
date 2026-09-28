---
title: Implemented personal memories
date: 2026-09-28
summary: "Encrypted, model-written, global and per-folder memories with four tools, a prompt section, and a Memory panel; review fixes applied."
---

# Implemented personal memories

## What happened

- Implemented `plans/260927-2359-personal-memories` in five phases:
  - Dexie v7 `memories` table with per-record AES-GCM (AAD `memory:<id>`), wiped by `recover()`;
  - `useMemoryStore` with serialized writes, per-scope important budget, duplicate-title conflicts, and folder scopes matched by handle (`sameDirectory`);
  - `remember`, `update_memory`, `forget`, `recall_memory` in `READ_ONLY_TOOLS` (no prompt), write tools blocked for sub-agents;
  - a `## Memories` system-prompt section (preamble, block-quoted important bodies, index);
  - a Memory rail panel.
- Bug found while testing phase 1: a workspace scope that did not exist yet was checked against global memories for duplicates. Fixed by treating a new scope as empty.
- Review (8/10, no critical) raised five warnings. Fixed:
  - W1: U+2028, U+2029, U+0085, `\v`, `\f` could split a line inside the prompt.
  - W2: a second tab could delete a folder handle still in use; cleanup now runs only in `hydrate`.
  - W3: no UI way to deny memory writes; the Memory panel now has a "Let the model save memories" toggle.
  - W5: the session wiring was untested; mutation-checked tests now cover it.
- W4 (user tools named like the memory tools are hidden) was accepted by the user.
- The panel save test was flaky because it waited one tick for encryption and a DB write; it now polls for the outcome.

## Tooling

- A shell hook rewrites `pnpm exec tsc` to a global TypeScript 5.9.3 that reports 46 false errors, because this project uses TypeScript 6.0.3 (strict by default, iterable DOM types). Use `rtk proxy pnpm exec tsc -b`.
- Two re-review subagents stalled at the 600s watchdog. The small fix diff was reviewed inline instead.

## Result

- `rtk proxy pnpm exec tsc -b` exit 0, `pnpm lint` exit 0, `pnpm exec vitest run` 147 files, 1779 passed, 1 skipped.
- Build and browser check not run (need the user's go-ahead).

## Next steps

- Browser check: ask the model to remember a preference, see it in the panel, edit it, confirm a new conversation uses it.
- Pre-existing, not fixed: `recover()` does not clear `db.journals`; `plans/README.md` index lists 8 of 16 plans.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
