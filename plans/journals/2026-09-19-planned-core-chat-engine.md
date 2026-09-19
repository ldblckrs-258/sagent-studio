---
title: Planned core chat engine
date: 2026-09-19
summary: "Hard-mode plan for a UI-agnostic chat core with encrypted history, skills, local-folder tools, and sandboxed JS/Python runners"
---

# Planned core chat engine

## What happened
Scouted the repo (Vite 8 / React 19 browser-only SPA with an encrypted Dexie vault) and confirmed there was no chat logic yet. Loaded `ak:brainstorm`, captured the four-field contract, and ran it under two rounds of material questions. Loaded `ak:plan` in hard mode: two researchers (browser runtime, AI SDK v7 + assistant-ui), then four hostile red-team reviewers, then a validation interview.

## Key findings that changed the design
- A same-origin `http(s)` web worker does **not** inherit a `<meta>` document CSP (HTML §7.1.7 + WPT), so the document can stay `script-src 'self'` and still run eval/WASM inside a Vite-bundled worker. The earlier "we must relax CSP" assumption was wrong.
- `CryptoKey` and `FileSystemDirectoryHandle` are structured-cloneable; the worker bridge must never carry them.
- `useChatRuntime` is not in the installed `@assistant-ui/react@0.15.20`; the installed bridge is `useExternalStoreRuntime` with an app-owned message array. assistant-ui has no undo primitive.
- `streamText` defaults to one step; a tool-using agent must pin `maxSteps`.
- `convertToModelMessages` is async and needs the same `ToolSet` as `streamText`.

## Decisions
- Plan: `plans/260919-0828-core-chat-engine`, 6 phases, 54h, active in the plan store.
- Engine owns `UIMessage[]`; pure reducer with `baseForMessage`; encrypted per-thread records through a shared vault write queue; `keyring` owns key+generation atomically.
- User decisions (Validation Session 1): accept worker network-egress risk; persist the folder handle (accepted risk); keep both `http` user tools (with host allow-list / no authority interpolation / body cap) and the thin `ChatTransport` adapter.
- Cut as a result of review: none. Red-team fixes applied for rerun semantics, abort sanitization, concurrent saves, skill prompt injection, and testability.

## Next steps
Implement via `/ak:cook plans/260919-0828-core-chat-engine/plan.md`. Phase 1's worker spike is a stop-the-line gate; browser-only checks must be recorded in `plans/journals/2026-09-19-implemented-core-chat-engine.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
