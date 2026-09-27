---
phase: 3
title: "Message action bar and rewind dialog"
status: in-progress
priority: P1
effort: "2.5h"
dependencies: [2]
---

# Phase 3: Message action bar and rewind dialog

## Goal

The user message action bar sits under the bubble as a hover-revealed bar (like the assistant bar) holding Edit and Rewind. Rewind opens a confirm dialog that previews the effect, performs the rewind, and puts the message text back in the composer.

## Context

- `src/components/assistant-ui/elements/thread.aui.tsx`:
  - `UserMessage` (~L961) positions `UserActionBar` absolutely to the left of the bubble (`aui-user-action-bar-wrapper`).
  - `UserActionBar` (~L1007) holds only Edit, with `hideWhenRunning` and `autohide="not-last"`.
  - The assistant footer (~L835-842) and `AssistantActionBar` (~L845) are the model for the new footer: a footer row with `ACTION_BAR_HEIGHT` and an `ActionBarPrimitive.Root` using `autohide="not-last"`.
- UI modules that talk to the engine live in `src/ui/` and use `useSession()` (for example `src/ui/approval-prompt.tsx`); `thread.aui.tsx` imports them.
- `src/components/ui/dialog.tsx` is the dialog primitive (used by `attachment.aui.tsx`).
- Busy signals: `useChatStore` (`runningThreads`, `compactingThreads`) and `agentRunStore` with `useRegistryVersion` (pattern in `src/ui/shell.tsx:251-253`).
- Composer prefill: `aui.composer.setText` is used inside composer scope (`src/ui/slash-suggestions.tsx:65`). Inside a message scope `aui.composer` may resolve to the message's edit composer. [UNVERIFIED] Which call reaches the thread composer from a message scope; verify against the installed `@assistant-ui/react` types before writing step 4.

## Files to Create / Modify

- Create: `src/ui/message-rewind.tsx` (Rewind button + confirm dialog)
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx` (footer bar for user messages)
- Modify: `src/tools/builtin/guides/checkpoints.md` (user rewinds appear as `restore` history entries)

## Tasks & Steps

1. **Footer bar** — in `UserMessage`, remove the absolute `aui-user-action-bar-wrapper`. Add a footer row after the bubble wrapper in column 2, right-aligned, reserving height the same way the assistant footer does so hover does not shift layout.
2. **`UserActionBar`** — render horizontally with `hideWhenRunning` and `autohide="not-last"` (same as `AssistantActionBar`). Contents: the existing Edit button (still gated by `capabilities.edit`), then `RewindButton`. Keep the `aui-user-action-edit` class.
3. **`RewindButton`** (`message-rewind.tsx`) — a `TooltipIconButton` with a lucide history-style icon.
   - Disabled with an explanatory tooltip only when the active thread is busy ("Wait for the run, sub-agents, and compaction to finish"). Messages without a marker stay enabled; the dialog offers a conversation-only rewind for them.
<!-- Updated: Validation Session 1 - no-marker messages stay enabled -->
   - Busy is derived reactively from the chat store and from `agentRunStore.list(threadId)` containing a `running` run.
4. **Dialog** — on open, call `session.engineFor(threadId).previewRewind(threadId, messageId)` and render:
   - how many messages will be removed;
   - files to restore, files to remove, unrestorable files, and conflicts (conflicts explained as "changed outside the agent; will be left as is");
   - the `files` status message for `no-marker`, `no-workspace`, `folder-mismatch`, and `expired` ("Only the conversation will be rewound");
   - one line stating that files return to the moment the message was sent, including writes by background agents after that moment;
   - when the thread composer holds a draft, a warning that the draft will be replaced.
   - Confirm calls `rewind`. On success, replace the thread composer text with the returned `text` (overwriting any draft) and close.
<!-- Updated: Validation Session 1 - composer draft is overwritten, with a warning in the dialog --> On `failed`, keep the dialog open and list what was restored before the failure. On `ChatRewindBusyError`, show the busy message.
5. **Guide** — add one bullet to `checkpoints.md`: a user rewind from the transcript restores files and appears as `restore` entries in `history`. Leave the stale "process-local" sentence as is and mention it in the handoff (not in scope).

## Verification

- `pnpm lint`
- `pnpm test` (full suite; thread UI tests such as `tool-view.test.tsx` must stay green)
- Manual in the running dev server (do not start a new one), driven by the agent through Chrome automation with a GIF recording of the flow:
<!-- Updated: Validation Session 1 - agent drives browser QA -->
  1. Send two turns that edit and create files; rewind on the second user message → edited file restored, created file removed, the second message and everything after it gone, its text in the composer.
  2. Edit a file in the in-app editor after an agent edit, then rewind → the file is listed as a conflict and keeps the manual edit.
  3. While a run or a sub-agent is active, Rewind is disabled.
  3a. A message from before this feature offers a conversation-only rewind.
  3b. With a draft in the composer, the dialog warns, and after confirming the composer holds the rewound message text.
  4. The bar is hidden until hover on user messages, and Edit still opens the inline edit composer.

## Risks

- Moving the bar can break the `peer-empty:hidden` behavior for image-only messages. Keep the footer hidden when the bubble is empty, matching the current wrapper.
- `autohide="not-last"` keeps the bar visible when a user message is the last message (for example after a failed pre-stream run). This matches the assistant bar and is accepted.
