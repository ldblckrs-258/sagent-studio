---
title: "Plan: chat file attachments"
date: 2026-09-20
summary: Planned composer file attachments; red team found the send path targeted an unreachable callback
---

# Plan: chat file attachments

Planned the chat file attachment feature (upload button, @ mention, tree drag, auto-attach chip) as
plans/260921-0512-chat-file-attachments, four phases.

What the plan pass actually produced beyond the obvious phase split:

- Three adversarial reviewers checked every file:line claim in the first draft. Four findings were
  blocking, and all four changed the design rather than the wording.
- The first draft wired attachment resolution into `useChatRuntime.onNew`. That callback is
  unreachable: the runtime routes every non-edit append into the message queue adapter and returns
  before calling it. Resolution now happens in the queue driver, with chips snapshotted at enqueue.
- The chip list had to become per-thread. The workspace handle is bound per thread and `bindThread`
  is async, so a global list would have resolved thread A's path against thread B's folder.
- `<attached>` as a plain delimiter was an injection channel: a repository file containing the
  closing tag can impersonate the user, which is the highest-trust role in the request. The plan now
  uses a per-turn nonce fence plus body neutralization.
- The auto-attach chip followed the shared File panel target, which `open_preview` also writes. Since
  that tool is ungated in every mode, the model could steer its own output into the next user turn.
  The chip now skips paths in the `authored` set and never inlines.

Four user decisions were confirmed after the review: 1 MB image cap, spike the unstable mention
adapter before hand-rolling, fixed `uploads/` destination, and secrets hidden from the index.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
