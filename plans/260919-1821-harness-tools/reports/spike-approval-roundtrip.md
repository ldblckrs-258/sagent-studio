# Spike: native AI SDK approval round-trip

- Date: 2026-09-20
- Packages: `ai@7.0.105`, `@assistant-ui/react@0.15.20`
- Automated run: `pnpm exec vitest run src/chat/approval-roundtrip.test.ts`
- Result: **native path works — fallback not needed**

## Observed

1. `streamText({ ..., tools, toolApproval: { write_file: 'user-approval' } })`
   emits a `tool-approval-request`; the tool's `execute` is **not** called.
2. `toUIMessageStream(...)` surfaces a `tool-write_file` part in state
   `approval-requested` with a non-empty `approval.id` (`aitxt-…`).
3. Marking that part `approval-responded` with `approval.approved: true` and
   re-invoking `streamText` on
   `convertToModelMessages([...], { ignoreIncompleteToolCalls: true })` executes
   the tool exactly once and resolves `result.text` to the continuation text.
4. `approval.approved: false` produces no execution and the converted model
   messages contain an `execution-denied` tool result.
5. A still-pending `approval-requested` part is dropped by
   `convertToModelMessages(..., { ignoreIncompleteToolCalls: true })`, so the
   engine must record the response before starting the resuming run.
6. `toolApproval: { write_file: 'approved' }` executes without any approval
   request.

## Decision

Implement the native path exactly as specified in
`phase-04-tool-approval-gates.md`. The fallback (`data-approval` card,
one-shot grant map) is **not** built.

## Browser-only half (pending)

A live provider turn that renders the assistant-ui approval card, approves, and
completes — plus a denial turn — is a browser-only check. It is recorded here
when the app is run manually:

- Command: `pnpm dev`, then a chat turn against a configured provider.
- Observed: _(to be recorded on a manual run)_.
