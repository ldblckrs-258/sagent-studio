---
title: Sub-agent system upgrades — prompt contract, compaction, structured output, profiles, continuation, gather, auto-continue, per-run changes
status: completed
created: 2026-09-27
branch: main
depends_on: ../260927-1950-subagent-refactor/plan.md
---

# Sub-agent system upgrades

## Outcome

Delegated agents:
- produce better results because they know what they are and how to report;
- survive long runs;
- can return typed results;
- come in named, reusable profiles;
- can be followed up or resumed;
- can be fanned out and gathered in one turn;
- can optionally wake the conversation when they finish.

Every file an agent changes is attributable to its run and revertible.

## Scope

Items A1–A3, B1–B4, and C1 from the brainstorm of 2026-09-27.

## Decisions (user, 2026-09-27)

- **Parent instruction:** a child does not inherit the parent conversation's
  system instruction. A profile opts in with `inherit-instructions: true`.
- **Profile sources:** built-in profiles plus workspace files
  `.agents/agents/*.md`. There is no vault storage and no editor UI.
- **Auto-continue:** off by default. When on, it runs at most 3 times since the
  user's latest message.
- **Revert conflicts:** "Revert this run" skips files changed after the run and
  reports them. It reverts the rest.

## Defaults chosen by the planner (change at cook time if needed)

- **`wait_agents` timeout:** 5 minutes by default, 30 minutes maximum.
- **`outputSchema`:** must be a JSON Schema with `type: "object"`, at most 8 KB.
  A failed extraction keeps the run `completed` and adds a `structuredError`.
- **Compaction trigger:** the child uses the same context cap and threshold as
  the parent (`resolveContextCap`), measured against the model for the child's
  tier.

## Constraints

- Fully client-side. AI SDK 7.0.105, assistant-ui 0.15.20.
- Existing `spawn_agent`, `stop_agent`, and `read_agent` inputs and outputs stay
  backward compatible. New fields are additive.
- Old persisted child threads and journals must still load, with missing new
  fields read as absent.
- One-level delegation. Every new agent-control tool (`message_agent`,
  `wait_agents`) joins `BLOCKED_AGENT_TOOLS`.
- No code comments (user rule). Do not run the dev server or builds without the
  user's go-ahead.

## Non-goals

- Vault-stored profiles and a profile editor.
- Nested delegation.
- A run timeline view.
- An `ask_parent` tool.
- Scoped "allow for this run" approvals.
- Configurable concurrency limits.

## Preconditions

- Commit the previous refactor (plan `260927-1950`) and the notice-anchoring fix,
  which are still uncommitted, before phase 1.

## Phases

| # | Phase | Item | Depends on | Status |
|---|-------|------|------------|--------|
| 1 | [Child prompt contract](phase-01-child-prompt-contract.md) | A1 | — | completed |
| 2 | [Child context compaction](phase-02-child-compaction.md) | A2 | 1 | completed |
| 3 | [Structured output](phase-03-structured-output.md) | A3 | 1 | completed |
| 4 | [Agent profiles](phase-04-agent-profiles.md) | B2 | 1 | completed |
| 5 | [Continue and resume runs](phase-05-continue-and-resume.md) | B3 | 4 | completed |
| 6 | [wait_agents](phase-06-wait-agents.md) | B1 | 5 | completed |
| 7 | [Auto-continue](phase-07-auto-continue.md) | B4 | 6 | completed |
| 8 | [Per-run changes and revert](phase-08-run-changes-and-revert.md) | C1 | 1 | completed |
| 9 | [Docs, review, verification](phase-09-docs-and-verification.md) | — | all | completed |

Phases 1–6 edit `runner.ts`, `runtime.ts`, and `tools/builtin/agents.ts`, so they
run in sequence. Phase 8 can run in parallel with 5–7, with ownership split as
follows:
- **Phase 8 owns:** `src/workspace/journal*`, the journal wrapper in
  `session.ts`'s `portsFor`, and a new `src/ui/run-changes.tsx`.
- **Phase 7 owns:** `engine.ts`, `vault/settings.ts`, and `ModelTiersPanel.tsx`.

## Architecture after the plan

```
spawn_agent / message_agent / wait_agents        (parent tools, blocked for children)
        │
AgentRuntime ── spawn · continue · steer · stop · read · wait
  │   persists RunSpec (profile, skills, excludeTools, outputSchema, tool pool)
  ▼
runAgent(seed?)
  system = composeAgentSystemPrompt(preamble, profile, projectInstruction, …)
  prepareStep: steering ▸ compaction (summary replaces old prefix)
  stream ▸ toUIMessageStream ▸ UIMessage[] (+ compaction markers)
  on completion: optional structured extraction (Output.object)
  ports.journal = tagJournal(parentJournal, runId)
        │
Notice / wait result carry: text · structured · filesChanged
Engine: idle notice ─(setting, cap 3)─▶ auto-continue marker + run
```

## Acceptance criteria

1. **System prompt.** A child's system prompt contains the sub-agent preamble,
   the project instruction when present, and the profile instructions. It
   contains the parent instruction only when the profile opts in. The task text
   is in the first user message and not in the system prompt.
2. **Compaction.** A run whose context passes the cap is compacted between steps.
   Later steps see a summary instead of the old prefix, a tool call is never
   separated from its result, and the run view shows a compaction marker and a
   context meter.
3. **Structured output.** `spawn_agent({ outputSchema })` returns a validated
   `structured` value in the tool result and in background notices. An invalid
   result yields `structuredError`, not a failed run.
4. **Profiles.** `spawn_agent({ agent: "reviewer" })` applies the profile's mode
   ceiling, tier, tool allowlist, skills, and instructions. Workspace profiles
   in `.agents/agents/*.md` load, and a broken file is reported without
   breaking the rest. The profile shows on list rows and in the run header.
5. **Continue and resume.**
   - A settled or interrupted run can be continued, from the run view composer
     or with `message_agent`, even after a reload.
   - The child sees its earlier history.
   - The transcript continues in place.
   - `message_agent` steers a running run.
6. **Gather.** `wait_agents` gathers `all` or `any` of the conversation's
   background runs in one turn, with a timeout. A gathered run appends no
   duplicate notice. A run still going at timeout keeps its notice.
7. **Auto-continue.** When enabled, an idle notice starts a new turn behind an
   "auto-continue" marker, at most 3 times since the user's latest message. When
   disabled, nothing changes.
8. **Per-run changes.**
   - Journal entries written by a child carry its `runId`.
   - The run view lists files changed, with diffs.
   - "Revert this run" reverts non-conflicting files and reports the skipped
     ones.
   - `filesChanged` appears in spawn results, wait results, and notices.
9. **Gates.** `pnpm test`, `pnpm lint`, and `pnpm exec tsc -b` pass. The build
   and browser check run only with the user's go-ahead.

## Verified facts (2026-09-27)

- In AI SDK 7, a `messages` override returned from `prepareStep` carries forward
  to the later steps of the same `streamText` call. A probe confirmed that a steer
  injected before step 2 was still present at step 3. Compaction relies on this.
- A child's system prompt is currently the raw task (`runner.ts`, the
  `composeSystemPrompt(request.prompt, …)` call). `AgentParentContext.systemInstruction`
  is passed in but never used, and the project instruction is never loaded for a
  child.
- `JournalEntry` has no run attribution. A child records into the parent
  thread's journal (`session.ts`, `portsFor`).

## Risks

- **Compaction cut points.** A bad cut can separate a tool call from its result,
  and the provider rejects that. Mitigation: cut only at a user-message
  boundary or right after a tool message, with property-style tests.
- **Extraction cost.** Structured extraction adds one model call. Mitigation: it
  runs only when `outputSchema` is set.
- **Continuation drift.** A continued run gets the parent's mode as it is now,
  and the tool pool as it was when the run started. The parent mode may have
  been lowered since. Mitigation: clamp again at continue time.
- **Auto-continue loops.** Mitigation: the cap, the off-by-default setting, and
  skipping while a run is in flight.
- **Revert data loss.** Mitigation: a two-step confirmation, conflict detection
  at apply time by comparing the current content with the run's last write, and
  each revert recorded as a `restore` entry so it can itself be undone.

## Execution notes (2026-09-27)

All 9 phases are implemented. The gates pass:
- `pnpm exec vitest run`: 1708 tests pass and 1 is skipped. The baseline was 1586.
- `pnpm exec tsc -b`: clean.
- `pnpm lint`: clean.

At the user's request, the build and the browser check were not run. The code review went through two fix cycles and scored 8/10. Its findings and fixes are in [the review report](../reports/code-reviewer-260927-2330-subagent-system-upgrades.md).

### Decisions made at cook time

- **Profile mode.** A profile's mode is a default. An explicit `mode` can raise it, but the parent's mode still caps it (user decision).
- **Revert.** `applyRunRevert` stays in `src/workspace/run-journal.ts`. It merges onto message-rewind's `applyRestore` once that lands (user decision).
- **Tool ceiling.** `message_agent` and `wait_agents` share the read-only ceiling with `spawn_agent`, so gathering never prompts for approval.

### Deviations from the phase text

- **Phase 1.** With no workspace, the child omits the project section, exactly as the parent does. A workspace without an instruction file shows "none found".
- **Phase 2.**
  - The compacted prefix keeps the original task verbatim.
  - A failed summary turns compaction off for the rest of that run.
  - The context figure is `max(reported inputTokens, estimate)`, because some providers do not report usage.
  - A continued run is rebuilt from the full transcript without its markers, then compacted again if it is over the cap.
- **Phase 3.** An in-house validator checks a subset of JSON Schema: `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items` and `anyOf`.
- **Phase 4.**
  - Profiles reload when the workspace folder changes, and before each spawn or continue.
  - `AgentSpawnOutcome` gains `invalid_input`.
  - `spawn_agent` without `agent` keeps its old mode and tier defaults.
- **Phase 5.**
  - `RunSpec` stores `mode` and `allowTools` instead of the provider and model, which the child thread config already holds.
  - The runner builds the seed history itself.
  - A continue reserves its run slot synchronously.
- **Phase 6.**
  - The runtime, not the session, suppresses the notice of a run that `wait_agents` gathered.
  - An aborted wait delivers the pending notices.
  - `mode: "any"` returns at once when a target has already settled.
- **Phase 8.**
  - The apply loop lives in `run-journal.ts`.
  - A conflict is any foreign journal entry after the run's first write to that path, plus a content check when the revert is applied.
  - A journal that evicted part of a run marks it `expired`. Results then carry `filesChangedIncomplete`.
  - `ToolDiff` moved into the tool-view primitives so the run view can reuse it.
- **Verified fact added.** In AI SDK 7, `result.response.messages` holds only the final step. A pass's history is therefore the last step's input followed by its response.

### Follow-ups

- **`RunChanges`.** The revert outcome is not reset when the same view continues the run; remounting the view clears it.
- **Estimate cost.** The history estimate serializes the whole history on every step and can overestimate, so compaction may fire early.
- **Duplicate result.** With `mode: "any"`, a target caught mid-settle can appear both in the result and as a notice. The window is short.
- **Capacity readout.** `activeCount` and `activeForThread` do not count a continue that is still reserving its slot.
- **Pre-existing.** `stop_agent` and `read_agent` are in no mode ceiling, so they prompt for approval in `read_only` and `editing`.
- **Profile trust.** A workspace profile can replace a built-in id and set `inherit-instructions`. The damage is bounded by the mode clamp and the tool pool.
