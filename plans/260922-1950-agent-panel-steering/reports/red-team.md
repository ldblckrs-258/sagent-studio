# Red team: agent panel steering and control

Four hostile lenses over the plan. Findings that changed the plan are marked
Applied.

## Assumptions

| # | Severity | Finding | Disposition | Applied |
|---|----------|---------|-------------|---------|
| A1 | High | `prepareStep` is assumed to accept an appended user message at any step boundary. If the tail is a partial tool call, the injected user message breaks role ordering. | Accept | Phase 1 — inject only when the tail is a tool result or assistant message; otherwise hold the message for the next pass. |
| A2 | Medium | The outer continuation loop resets the per-pass step count, silently doubling the step budget. | Accept | Phase 1 — track total steps across passes against a combined cap. |
| A3 | Medium | `result.response` is assumed populated after consuming `fullStream`; if a pass aborts mid-stream it may reject. | Accept | Phase 1 — wrap the response read in try/catch and keep the last good history. |

## Failure

| # | Severity | Finding | Disposition | Applied |
|---|----------|---------|-------------|---------|
| F1 | High | `read` was specified as synchronous while a settled run must load from async persistence. | Accept | Phase 2 — `read` is async; `AgentRunSnapshot` load path covered. |
| F2 | High | No way to resolve a `label` to a run; tools would guess. | Accept | Phase 2/3 — add `resolveRun` to the runtime and port; tools fail on ambiguity. |
| F3 | Medium | A steering message enqueued in the window after the drain and before settle is dropped silently. | Accept | Phase 5 — composer disabled once status leaves `running`; `steer` returns false when not live so the UI can say so. |
| F4 | Low | Stop during an in-flight approval: the queue must settle. | Covered | Existing `settleAll(false)` on abort (Phase 1 unchanged). |

## Scope

| # | Severity | Finding | Disposition | Applied |
|---|----------|---------|-------------|---------|
| S1 | Medium | Adding control tools to a child's toolset would let a sub-agent stop or read siblings. | Accept | Phase 3 — `BLOCKED_AGENT_TOOLS` gains `stop_agent` and `read_agent`. |
| S2 | Low | `read_agent` could flood the parent context. | Accept | Phase 3 — clamp `lastN`, truncate per turn. |
| S3 | Low | Resume of a settled run is out of scope but not stated. | Accept | Plan non-goals already exclude resuming a stopped run; add explicitly. |

## Security

| # | Severity | Finding | Disposition | Applied |
|---|----------|---------|-------------|---------|
| X1 | High | Cross-conversation stop/read if ownership is checked only in the port closure. | Accept | Phase 2 — every runtime method re-checks the parent thread. |
| X2 | Medium | Sub-agent text rendered as markdown could inject markup. | Covered | Phase 4 — `react-markdown` escapes HTML; no `rehype-raw`. |
| X3 | Low | Read output must be flagged untrusted. | Accept | Phase 3 — `untrusted: true`. |

No finding was rejected. No unresolved contradictions remain.

## Post-gate scope addition

The user reported a live defect: a sub-agent report always renders at the end of
the parent turn. Diagnosed to the notice deferral plus the stale-`siblings`
stream write (see Phase 6). Added as Phase 6 and modeled with a `data-agent-notice`
part written inline at arrival. No other phase depended on the old deferred
behavior, so no earlier phase changed.
