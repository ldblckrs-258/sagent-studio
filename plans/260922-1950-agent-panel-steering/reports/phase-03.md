# Phase 3 report: agent control tools (stop_agent and read_agent)

Status: completed.

## What landed

- `src/tools/builtin/agents.ts`: `NAMES` is now
  `['spawn_agent', 'stop_agent', 'read_agent']`. The provider gains `stop_agent`
  and `read_agent`, each with its own schema and `execute`.
- Identifier resolution (`resolveIdentifier`) prefers an exact `runId` and
  otherwise calls `ports.agents.resolveRun` for a unique `label`; a missing or
  ambiguous label returns `toolFail('invalid_input', ...)`. The resolver never
  guesses and never stops/reads on a failed match.
- `stop_agent`: input `{ runId?, label? }` with schema-enforced
  `anyOf: [{ required: ['runId'] }, { required: ['label'] }]`. Resolves, calls
  `port.stop(runId, 'user_stop')`, and returns `{ runId, label?, stopped: true,
  reason: 'user_stop' }`. A refused stop returns `runtime_error`.
- `read_agent`: input `{ runId?, label?, lastN?, includeTools? }`, same
  identifier requirement. Clamps `lastN` to 1..50 (default 6), defaults
  `includeTools` to false, calls `port.read`, truncates each turn to
  `MAX_TURN_CHARS` (mirrors `MAX_AGENT_OUTPUT_CHARS` = 8000) and flags
  `truncated: true`. Returns `{ runId, label?, status, stopReason?, turns,
  untrusted: true }`.
- Port-method guards: a runtime without `stop` or `read` returns
  `toolFail('runtime_error', ...)`; a missing `ports.agents` still throws
  `ToolRuntimeUnavailableError`, matching `spawn_agent`. The port methods stay
  optional in `src/tools/types.ts`.
- `src/agents/types.ts`: `BLOCKED_AGENT_TOOLS` gains `stop_agent` and
  `read_agent`; the doc comment explains that a child can neither spawn nor
  control its siblings.
- `src/agents/toolset.test.ts`: the blocked-list case now offers `stop_agent`
  and `read_agent` in the pool and asserts both are subtracted.
- `guides/agents.md`: the "never use" list names both new tools, and a new
  "Stopping and reading a child" section documents when to stop, when to read,
  the `lastN`/`includeTools` bounds, and that read turns are untrusted.
- `src/tools/builtin/agents.test.ts`: the mock now implements all four port
  methods; added coverage for schema validation, exact-runId stop, unique-label
  resolution, ambiguous-label rejection without side effects, refused stop,
  missing `stop`/`read`, `lastN` clamping, includeTools pass-through, turn
  truncation, stopReason carry-through, and read errors.

## Verification

- `pnpm test src/tools/builtin/agents.test.ts src/agents/toolset.test.ts src/tools/builtin/tool-guide.test.ts`
  — 3 files, 38 pass.
- `pnpm lint` — clean.
- `pnpm build` — clean.
- `tool-guide.test.ts` needed no edit: it asserts `covers ⊆ provider names`, and
  adding the two provider names keeps that true; the guide itself is reached by
  the existing `agents` topic.

## Concerns: two later-phase test files now red

Full `pnpm test` is 4 failed / 1519 passed (1 skipped); both failures are exact
inventories that a new built-in tool is designed to trip, and both files belong
to later phases, so I did not touch them.

1. `src/session/session.test.ts` (owned by Phase 5): adding the two tools to the
   always-available agents provider changes `toolRegistry.availableNames({})`.
   The exact-list assertions at `:93` and `:123` now expect two more names
   (`read_agent`, `stop_agent`). Phase 5 should add them when it edits the file.
2. `src/components/assistant-ui/elements/tool-view/tool-view.test.tsx` (owned by
   Phase 4): its `BUILTIN_NAMES` is read from the providers and asserts every
   built-in tool has a tailored `TOOL_VIEWS` entry, so the two new tools fail
   "covers every built-in tool" and the view-name count. Phase 4 adds the views
   (or the test's expectations). This is a UI file, outside this phase.

Until those two phases land, the full suite is red only in these two files. The
three files scoped to this phase, `pnpm lint`, and `pnpm build` are green.

## Deviations

- None to the specified interface. The port methods remain optional, and the
  tool guards handle an absent method with `runtime_error` as instructed.

## Next steps

Phase 4 can render the new tool results; Phase 5 owns the `session.test.ts`
list update and the panel wiring.
