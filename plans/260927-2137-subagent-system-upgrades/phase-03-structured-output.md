---
phase: 3
title: Structured output
item: A3
status: completed
---

# Phase 3 — Structured output

## Goal

The parent can ask for a typed result and get validated JSON back, alongside the
text report.

## Files

- Modify:
  - `src/tools/builtin/agents.ts`: schema and output.
  - `src/agents/types.ts`: `AgentRequest.outputSchema`,
    `AgentRunResult.structured` / `structuredError`.
  - `src/agents/runner.ts`
  - `src/chat/types.ts`: `AgentNoticeReport.structured?`.
  - `src/session/session.ts`: `noticeFor`.
  - `src/components/assistant-ui/elements/sub-agent-report.aui.tsx`
  - `src/components/assistant-ui/elements/tool-view/details/agents.tsx`
  - Tests.
- Read first: the AI SDK 7 `Output.object` / `generateText` `output` API in
  `node_modules/ai/dist/index.d.ts`. Confirm the exact names before coding.

## Steps

1. `spawn_agent` input gains `outputSchema?: object`. Validate that it is a plain
   object with `type: "object"` and that its serialized size is at most 8 KB.
   Otherwise return an `invalid_input` envelope.
2. Runner: when the run ends `completed` and `outputSchema` is set, make one
   extraction call:
   - `generateText({ model, system: EXTRACT_SYSTEM, messages: [...history,
     { role: 'user', content: EXTRACT_REQUEST }], output: Output.object({
     schema: jsonSchema(outputSchema) }), abortSignal })`.
   - On success, set `structured`. On failure or validation error, set
     `structuredError`. Status stays `completed`.
   - Add the extraction's usage to the run usage.
3. Outputs:
   - The awaited `spawn_agent` result adds `structured` / `structuredError`.
   - The background notice report adds `structured`.
   - The notice's model-visible text appends the JSON in a fenced block, so the
     parent model can read it.
4. UI: the report card and the `spawn_agent` detail render `structured` with the
   existing `ValueView` under a "Structured result" section.

## Tests (intent)

- A valid schema with a mock extraction returning a matching object gives
  `structured` equal to that object.
- A non-matching object gives `structuredError` with status `completed`.
- A schema without `type: "object"`, or one over 8 KB, is rejected with
  `invalid_input` before any run starts.
- No `outputSchema` means no extraction call (count the model calls).
