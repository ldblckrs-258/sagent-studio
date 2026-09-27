---
title: Sub-agent runs moved onto the main message pipeline
date: 2026-09-27
summary: "Replaced three hand-written event-to-message projections with the AI SDK's toUIMessageStream pipeline; runs open full-width with the main thread's shell and composer."
---

**What happened.** Tool calls in sub-agent threads rendered empty, for example
`list_dir` showing "0 entries", even though the model had received the result.
That was the second report of this bug class. The first fix on 09-23 patched
one of three independent projections of the same event log: live, persisted,
and `read_agent`.

**Diagnosis.** Probes under a mock model found no loss in the SDK stream, the
live projection, incremental rendering, or runtime persistence. The trigger in
the user's session was not reproduced. Two things were confirmed:

- Runs persisted before the fix have `{}` baked in.
- The persisted projection wrote every tool call as finished and empty until its
  result arrived, and it ignored tool errors.

Probes also found two unreported defects:

- `isRunning: false` made a running tool render Allow/Deny.
- Run messages offered Regenerate.

**Decision.** Removed the class of bug rather than the instance:

- The runner tees `result.stream` into the same `toUIMessageStream` /
  `readUIMessageStream` path as `engine.ts`.
- `record.messages` becomes the single source for the store, persistence,
  `read_agent`, and the UI.

**Surprise.** assistant-ui's external store already has a queue adapter with a
`steer` lane. That replaced the old workaround of reporting an idle thread so
the composer could send.

**Review catch.** An optimistic steer appended as the last message turned the
in-flight tool, now no longer last, into `requires-action`, which rendered
Allow/Deny again. Pending steers now render outside the runtime.

**Lesson.** When the same data has more than one projection, fixing one of them
fixes nothing durable. Look for the pipeline that already exists and delete the
copies.

> Historical work record — not durable authority.
