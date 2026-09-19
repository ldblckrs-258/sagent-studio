---
title: Planned chat interface
date: 2026-09-19
summary: Hard-mode plan for a three-column assistant-ui chat shell over the implemented core chat engine
---

# Planned chat interface

## What happened
Loaded `ak:brainstorm` on top of the implemented core chat engine, captured the four-field contract, then loaded `ak:plan`, which auto-detected hard mode for this UI plan. Two parallel researchers ran: researcher-01 on `@assistant-ui/react@0.15.20` integration and researcher-02 on repo UI patterns and test reality. A planner authored six phases. Four hostile red-team reviewers then attacked the plan against the installed typings and the live `src/` tree, and a five-question validation interview closed the session.

## Key findings that changed the design
No application code instantiates the engine or the registries today; `createEngine`, `SkillRegistry`, `ToolRegistry`, `JsRunner`, and `PyRunner` appear only in tests, so Phase 1 must add the app-level session composition before any panel can be wired. The installed bridge is `useExternalStoreRuntime` only, because 0.15.20 ships no `useChatRuntime`. Supplying `setMessages` silently enables the runtime's message-delete path, so `onDelete` must be provided and routed through `reducer.deleteMessage` plus `saveThread`. The reducer's `editMessage` keeps every later message, so the engine's edit path is not actually destructive even though the UI assumes it is. `createCodeToolProvider` captures runners and hardcodes `isAvailable: () => true`, so sandbox enablement and timeouts cannot reach model tools without a runner source. `DefaultEngine` discards its `registerAbortAll` unsubscribe, so abort callbacks accumulate per thread. Tests are node-only, with no jsdom or testing-library installed.

## Decisions
Single workspace with a snapshotted folder label on each thread. Destructive edit and rerun, with the branch picker removed. One right-rail tabbed config panel replacing the plain page. App-owned conversation list grouped by workspace. Monaco editor, self-hosted. Drawers and overlay collapse on narrow viewports. A per-session scratchpad workspace toggle. Manual thread titles only, and single-record skills and tools management.

## Red team
Fifteen deduped findings were presented, five Critical and ten High, plus thirteen additional medium and low findings; all were accepted and none were rejected. The five Critical findings were that sandbox enablement cannot gate `run_js`/`run_python` because the code provider captures runners and reports always available, that `setMessages` enables message delete without persistence, that `engine.editMessage` is not destructive though labeled as such, that required `Settings.sandbox` and `ThreadSummary.title` fields break unlisted consumers, and that `ProvidersPanel` had no home in Phases 1-3 while Phase 2 linked to a nonexistent tab.

## Next steps
Implement via `/ak:cook plans/260919-1437-chat-interface/plan.md`. Every phase's browser gate must be recorded with date, build hash, browser, command, and observed result in `plans/journals/2026-09-19-implemented-chat-interface.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
