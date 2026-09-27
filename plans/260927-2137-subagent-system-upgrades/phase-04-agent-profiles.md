---
phase: 4
title: Agent profiles
item: B2
status: completed
---

# Phase 4 — Agent profiles

## Goal

Named, reusable agent definitions. A few profiles ship built in; a project adds
its own as markdown files.

## Files

- Add: `src/agents/profiles.ts`, `src/agents/profiles.test.ts`,
  `src/agents/profile-workspace-source.ts`
- Modify:
  - `src/agents/types.ts`: `AgentRequest.agent`.
  - `src/agents/toolset.ts`: allowlist.
  - `src/agents/runner.ts`, `src/agents/runtime.ts`
  - `src/agents/store.ts`: `profile` on the record.
  - `src/chat/types.ts` and `src/chat/persistence.ts`: `AgentThreadMeta.profile`.
  - `src/tools/builtin/agents.ts`: the `agent` param and a dynamic description.
  - `src/session/session.ts`: registry and loading.
  - `src/ui/panels/agents.tsx` and `src/ui/agent-run-view.tsx`: the chip.
- Read first:
  - `src/skills/parser.ts`, `src/skills/workspace-source.ts`, and
    `src/skills/registry.ts`: follow the same loading and version idiom.
  - How the skills panel triggers `loadWorkspaceSkills`.

## Steps

1. `AgentProfile` has these fields:
   - `id`, `name`, `description`
   - `mode?`, `tier?`
   - `tools?` (allowlist), `excludeTools?`, `skills?`
   - `inheritInstructions?`
   - `instructions`
   - `source: 'builtin' | 'workspace'`, `path?`
2. Built-in profiles:
   - `explorer`: `read_only`, `cheap`. Locates and maps code, and reports
     `path:line` evidence.
   - `reviewer`: `read_only`, `high`. Reports findings by severity with
     `file:line`, a failure scenario, and a fix.
   - `planner`: `read_only`, `high`. Produces phased steps, risks, and
     verification.
   - `worker`: `editing`, `medium`. Implements a bounded change, runs checks, and
     reports the diff.
3. `parseAgentProfileMarkdown(markdown, fallbackId)` reads YAML frontmatter with
   `name`, `description`, `mode`, `tier`, `tools`, `exclude-tools`, `skills`, and
   `inherit-instructions`. The body is the instructions. Invalid values are
   errors naming the field.
4. The workspace source reads `.agents/agents/*.md`. The file stem is the id, and
   a workspace id overrides a built-in with the same id. A bad file is recorded
   as a load error and the rest still load.
5. `AgentProfileRegistry` (subscribe/version) lives in the session. It reloads
   through the same trigger the skills use.
6. Resolution in the runtime, before the toolset:
   - Explicit request fields override profile defaults.
   - The mode is still clamped to the parent.
   - The tool pool is the parent pool ∩ the profile allowlist (when set) minus
     the excludes.
   - Profile skills are merged with the requested ones.
   - An unknown profile id returns `invalid_input` and lists the available ids.
7. The profile's instructions and `inheritInstructions` feed
   `composeAgentSystemPrompt` (phase 1).
8. The `spawn_agent` tool description lists the available profiles (id and
   description), built when the tool is created for a turn.
9. The profile id is stored on the record, the snapshot, and the thread meta. It
   shows as a chip on list rows and in the run header.

## Tests (intent)

- A built-in profile applies its mode, tier, and tools. An explicit `tier`
  overrides it. The mode never exceeds the parent's.
- The allowlist cannot add a tool the parent lacks.
- A workspace file overrides a built-in id. A malformed file surfaces an error
  and the others still load.
- An unknown id returns `invalid_input` listing the ids.
- `inherit-instructions: true` puts the parent instruction into the system prompt.
