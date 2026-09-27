# Agents panel UI refactor

Post-implementation request: the Agents list and flow view looked unlike the
rest of the app. The panel now reuses the main thread's actual conversation
rendering and message input, and a sub-agent tool call in the transcript links
to its run in the panel.

## Why the first pass missed

The Agents panel renders outside `AssistantRuntimeProvider`, and the main
thread's conversation display and composer are assistant-ui runtime components.
The first pass built a lookalike from shared CSS instead of reusing the real
components. This pass mounts a runtime for the selected run so the real
components render.

## What changed

- `src/agents/run-messages.ts` projects a live run's event log into the same
  `UIMessage` shape the main thread uses (prompt + assistant turns + steering
  turns, tool calls as real tool parts). Consecutive text deltas coalesce into
  one text part, and a tool call only becomes complete once its result arrives
  (a settled run closes any the log never resolved), so assistant-ui never draws
  an approval prompt for a finished call. `normalizeThreadMessages` applies the
  same repair to a persisted transcript written before this change.

## Fixed after the first runtime-backed pass

- Per-delta text parts rendered one word per line; now coalesced.
- Tool parts with no result rendered Allow/Deny approval buttons on a finished
  run; now marked complete (or running while live).
- `src/chat/use-subagent-runtime.ts` builds an assistant-ui runtime over those
  messages. The run is presented as an idle thread because the main composer
  queues a send while `isRunning`, which would swallow a steering turn; the run
  status is shown in the panel header instead.
- `src/components/assistant-ui/elements/thread.aui.tsx` exports `ThreadMessage`,
  the role dispatcher the main thread already uses.
- `src/ui/panels/agent-flow-view.tsx` wraps a `ThreadPrimitive` message list and
  a `ComposerPrimitive` composer in `AssistantRuntimeProvider`, so the panel
  draws the same user bubbles, assistant markdown, tool-call views, and the same
  message input as the main thread. A runtime-backed composer send routes to
  `session.steerAgentRun`.
- `src/ui/panels/agents.tsx` keeps the sectioned list (Active / Recent) and a
  clean row.
- `src/session/agent-panel-state.ts` + `src/ui/shell.tsx` reveal the rail on a
  sub-agent tool call.
- `.../tool-view/details/agents.tsx` adds an always-visible panel action to the
  disclosure header of `spawn_agent`, `stop_agent`, and `read_agent`. The
  completed `spawn_agent` result now carries its `runId`, so an awaited run is
  openable too.
- `src/ui/primitives.tsx` `Button` now forwards its ref, required by
  `ComposerPrimitive.Send asChild`.

## Verification

- `pnpm test` 134 files, 1558 passed, 1 skipped
- `pnpm lint` clean
- `pnpm build` clean
- `src/test-setup.ts` stubs jsdom's missing `ResizeObserver` / `scrollTo` for the
  runtime-backed panel tests.

## Known limitations

- The sub-agent's tool results are not in the run event log, so a tool call
  renders with its arguments but no output.
- The panel was verified by tests and static review, not a live browser pass.
