# Phase 6 report: sub-agent notice appears inline at arrival

Status: completed (one cross-phase test concern, see below).

## What landed

- `src/chat/types.ts` defines `AgentNoticePart` (`data-agent-notice`, payload
  `{ text: string } & AgentNoticeMeta`) and the `isAgentNoticePart` guard.
- `appendAgentNotice` writes immediately; `noticeQueue`, `flushNotices`, and the
  `inFlight` counter are gone. If the thread has a streaming assistant message,
  the notice part is appended to its parts at the tail, deduped by a stable
  notice key (run id, else payload). Otherwise it is written as a standalone
  notice message that keeps the `agentNotice` metadata marker and the legacy
  text part.
- `executeRun` no longer rebuilds `[...siblings, partial]`. Each chunk and the
  final write call `updateAssistantMessage`, which maps over the current store
  messages, replaces the message with `assistantId`, and merges back any notice
  parts the render did not carry (`mergeNoticeParts`). Other messages are left
  untouched, so an injected notice survives every subsequent chunk, the final
  `finished` write, persistence, and a resume (the paused tool part comes from
  the streamed reconstruction).
- `startRun`'s placeholder write and the pre-stream failure write preserve any
  message that landed while the pre-run compaction was in flight.
- `compact` carries over messages appended during the summary call, so an idle
  notice that arrives mid-compaction is not dropped.
- `thread.aui.tsx` registers an `agent-notice` data renderer inside
  `AssistantMessage` (via `useAssistantDataUI`; `GroupedParts` has no
  `components` prop, and `case "data"` already returns `part.dataRendererUI`),
  and the standalone branch detects the `agentNotice` marker (carried through
  `convert.ts` custom metadata) to render `SubAgentReport` without a bubble or
  Regenerate.
- `convert.ts` carries the `agentNotice` marker into custom metadata.
- `persistence.ts` `validateAgentMeta` parses `stopReason`, with a round-trip
  test.

## Why the data part needs no `convert.ts` mapping

`convertPart` already maps any `data-*` part to `{ type, data }`; the runtime's
`fromThreadMessageLike` turns `data-agent-notice` into
`{ type: "data", name: "agent-notice", data }`, which the registered renderer and
the `case "data"` branch consume. `sanitizePartial`, `rehydrateThread`, and
`reconcileAgentResultPart` only rewrite tool parts, so reload keeps the notice;
asserted directly in the engine test.

## Verification

- `pnpm test src/chat/engine.test.ts src/chat/convert.test.ts src/chat/persistence.test.ts src/components/assistant-ui/elements/sub-agent-report.test.tsx` — 110 pass.
- `pnpm lint` — clean.
- `pnpm build` — clean.
- Full `pnpm test` — 132 files, 1542 pass, 1 skipped; the single failure is the
  pre-existing `src/agents/agent-e2e.test.ts` notice test (see below).

## Concern: cross-phase e2e expectation

`src/agents/agent-e2e.test.ts` "appends exactly one notice when a background
agent settles" identifies the notice by `metadata.agentNotice` and asserts the
notice text lives in a text part. The mock sub-agent settles while the parent
turn is still streaming, so the notice is now inline on the assistant message and
carries no standalone marker — exactly the Phase 6 requirement. That file is
owned by Phase 7 (which lists it in "Files to Modify" and extends it with the
spawn/steer/stop/read scenario) and is outside this phase's file ownership, so it
is left for Phase 7 to update, not weakened here.

## Deviations

- `sub-agent-report.aui.tsx` needed no edit: its `report: AgentNoticeMeta` prop
  already accepts the new payload structurally (the payload is a superset), and
  `thread.aui.tsx` passes `data` straight through. Verified by `tsc` and the
  report test.
- Notices append only to assistant messages whose `chatStatus` is `streaming`;
  an idle thread writes the standalone form. No global in-flight counter remains.
