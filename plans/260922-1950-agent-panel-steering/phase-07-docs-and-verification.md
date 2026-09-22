---
phase: 7
title: "Docs and end-to-end verification"
status: pending
priority: P2
effort: 1d
dependencies: [1, 2, 3, 4, 5, 6]
---

# Phase 7: Docs and end-to-end verification

## Goal

Document the new tools and the panel controls, and prove the whole steering and
stop flow end to end.

## Overview

The feature changes the model-visible tool surface (`stop_agent`, `read_agent`),
the run status vocabulary (`stopped`), and the Agents panel. Update the README
tool description and the agents tool guide, then add an end-to-end test covering
spawn, steer, stop, and read, and run the full quality gates.

## Key Insights

- **Model-visible docs live with the tool.** `src/tools/builtin/guides/agents.md`
  is loaded by the tool-guide system; it is the primary place to explain when to
  stop or read a child.
- **The README lists built-in capabilities.** Update its sub-agent/agents wording
  so the control tools and the `stopped` outcome are discoverable.
- **The existing e2e harness injects mock models.** `src/agents/agent-e2e.test.ts`
  already wires a runtime with an injected `modelFactory`; extend that pattern
  rather than building a new harness.
- **Status vocabulary is public.** A `stopped` status is user-visible everywhere
  a run's status renders; the acceptance check must cover the panel and the
  notice.

## Requirements

- `guides/agents.md` documents `stop_agent` and `read_agent`, including the
  `lastN` bound and that read output is untrusted.
- README's agent section mentions steering, force-stop, and the `stopped` status.
- An end-to-end test covers: spawn a background run, steer it, observe the extra
  model turn, stop it, assert `stopped` + `user_stop` on the child thread and the
  parent notice, read its last N turns, and assert a mid-turn notice renders
  inline rather than at the end of the turn.
- Full gates pass: `pnpm test`, `pnpm lint`, `pnpm build`.

## Files to Modify

- Modify: `src/tools/builtin/guides/agents.md`
- Modify: `README.md`
- Modify: `src/agents/agent-e2e.test.ts`
- Modify: `src/tools/builtin/tool-guide.test.ts` (if it asserts guide content)

## Implementation Steps

1. Document the two control tools in `guides/agents.md` with a short "Stopping
   and reading a child" section and the untrusted-output caveat.
2. Update the README's sub-agent description for steering, force-stop, the
   `stopped` status, and the new tools.
3. Extend `agent-e2e.test.ts` with the spawn → steer → stop → read scenario,
   asserting the child thread's `agent.status`/`stopReason`, the parent notice,
   and the read projection.
4. Run `pnpm test`, `pnpm lint`, and `pnpm build`; fix any regression rather than
   weakening a test.

## Verification

- `pnpm test`
- `pnpm lint`
- `pnpm build`

## Success Criteria

- The guide and README describe the new tools and the stopped outcome.
- The end-to-end test proves steering, stopping, and reading in one run.
- All three gates pass.

## Risk Assessment

- **Flaky timing:** keep the e2e deterministic with injected mock models and
  awaited settle promises; never rely on real timers.
- **Doc drift:** link the README to the tool guide rather than duplicating the
  full schema.

## Security Considerations

- Docs must state that `read_agent` output is untrusted and parent-scoped.
- No secrets or local absolute paths in published docs.

## Next Steps

- After the gates pass, hand off to `/ak:ship` for review and merge.
