---
title: "Chat file attachments — upload, @ mention, drag, auto-attach"
description: "Attach workspace files and folders to a chat turn through an upload button, an @ path autocomplete, drag from the workspace tree, and an auto-follow chip for the file the user opened, with a compact chip bar inside the composer shell."
status: completed
priority: P1
effort: "3d"
branch: feat/token-metering-and-compaction
tags: [feature, frontend, chat, workspace]
blockedBy: []
blocks: []
created: 2026-09-21
---

# Chat file attachments

## Overview

The composer sends text only. Every composer send is routed into the message queue (`src/chat/use-chat-runtime.ts:236` always supplies `queue: queue.adapter`), the queue driver keeps nothing but `extractText(message.content)` (`src/chat/queue.ts:76-87`), and `engine.sendTurn(threadId, text)` builds a single text part (`src/chat/engine.ts:462`). A user who wants the model to look at a file must type its path and hope the model calls `read_file`.

This plan adds four entry points that converge on one per-thread attachment list: an upload button that writes the picked file into the workspace, an `@` autocomplete over workspace paths, a drag source on the workspace tree, and an auto chip that follows the file **the user** opened in the File panel. The list renders as a compact chip row inside the composer shell, above the input and below the floating approval prompt, so the two never overlap.

Attachments resolve when the turn actually dispatches, so an edit between attaching and sending is reflected. Inlined bytes are repository data in the user role, which is the highest-trust channel a provider sees, so the fencing rules in this plan are load-bearing rather than cosmetic.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Upload a local file into the workspace from the composer and attach it | P1 |
| 2 | Attach a workspace file by typing `@` and completing a path | P1 |
| 3 | Attach a file or folder by dragging it from the workspace tree onto the composer | P1 |
| 4 | Auto-attach the file the user opened in the File panel, detachable per thread | P1 |
| 5 | Render attached items as a compact chip row that never overlaps the approval prompt | P1 |
| 6 | Turn attachments into message parts with a size-aware inline/reference split that untrusted bytes cannot break out of | P1 |

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Attachment payload | Hybrid: inline text files under 32 KB, reference marker for larger files, binaries, folders, and every auto-sourced chip | Small files are what "look at this" means; a large file or a folder would exhaust the context window, and `read_file`, `list`, and `search` already exist for the model to pull the rest |
| Fencing | One 16-hex-char nonce per turn. Blocks open `<attached id="{nonce}" …>` and close `</attached-{nonce}>`; the body has `<attached`, `</attached`, the nonce itself, and C0 controls other than `\n`/`\t` replaced with `�` | Without this, a repository file containing `</attached>` closes the block and the bytes after it are structurally indistinguishable from the user's own instruction. The two existing untrusted paths both neutralize delimiters: `clampIndexText` collapses and clamps (`src/chat/context.ts:42-59`), and `read_file` returns JSON-escaped content in the tool role (`src/tools/builtin/workspace.ts:279-289`) |
| Upload destination | Write the blob into the workspace under `uploads/`, then attach it as an ordinary workspace path | One attachment model instead of two, and every harness tool can read the file afterwards. `src/ui/file-view/use-text-document.ts:63-65` already writes user edits straight through `WorkspaceFs` |
| Uploads and permission modes | Uploads work in every chat mode, including `read_only`, and the UI names the destination path before writing | `ChatMode` gates the model, not the user: `MODE_GUIDANCE` addresses the model (`src/chat/context.ts:30-37`) and `resolveApprovalStatus` keys on tool names only (`src/tools/approval.ts:131-165`). The read-only menu text promises "Every change asks first" (`src/ui/composer-controls.tsx:57`), so the destination has to be visible rather than silent |
| Binary write API | New free function `writeWorkspaceBlob(fs, path, blob)` | `WorkspaceFs.writeFile` takes a `string`. A free function mirrors `readWorkspaceBlob` (`src/workspace/fs.ts:547`) and keeps every existing `WorkspaceFs` mock valid; the in-memory fake, which stores content as a string, is a separate change |
| Auto-attach source | Follows `useFileViewStore.target` only when the path is **not** in `useFileViewStore.authored`, and an auto chip never inlines | `open_preview` is ungated in every mode (`src/tools/approval.ts:37`) and calls `presentWorkspace` on the same shared target (`src/session/session.ts:126-128`), and the system prompt tells the model to call it after every such write (`src/chat/context.ts:25`). Without the `authored` check, model output — or any file the model is talked into previewing — rides into the next user turn |
| Attachment scope | The chip list is keyed by thread id and cleared on a real thread-to-thread change | The workspace is bound per thread (`src/session/session.ts:161-164`, `src/session/workspace-state.ts:138-160`), so a global list would resolve thread A's path against thread B's folder. The queue already resets on the same edge (`src/chat/use-chat-runtime.ts:114-119`) |
| Attachment lifetime | Manual chips are captured and cleared when the message is enqueued; the auto chip stays | Matches every other chat client, and stops a forgotten chip from re-billing context every turn |
| Dispatch point | Chips are snapshotted at enqueue and resolved in the queue driver, not in `onNew` | Every non-edit append returns into the queue before `onNew` is reached (`@assistant-ui/core/src/runtimes/external-store/external-store-thread-runtime-core.ts:667-679`), so `onNew` is dead code in this app |
| Re-inline suppression | A user message records `metadata.attachments` (path, hash, mode); a later turn inlining the same path with the same hash sends a marker that also tells the model to `read_file` if the content is not visible | The auto chip survives sends. The marker must fail safe because compaction can bury the original in the same turn it is suppressed (`src/chat/engine.ts:748-752`) |
| Image attachments | Inline as a `file` part with a data URL, capped at 1 MB, media type from an explicit `IMAGE_MEDIA_TYPES` map covering png, jpeg, gif, and webp; SVG goes through the escaped text path | A `file` part is the only way a vision model sees the image. The cap is low because the data URL is persisted and re-sent on every turn in the window (`src/chat/persistence.ts:88-95`, `src/chat/engine.ts:376-382`). SVG is XML text and a second injection channel, and `kind.ts` has no MIME map to source a media type from |
| Image token estimate | `Math.ceil(bytes / 750)`, bounded | A `file` part contributes zero today (`src/chat/usage.ts:86`), and that number feeds the auto-compaction gate (`src/chat/engine.ts:699`). Counting the base64 string with `CHARS_PER_TOKEN = 4` would read a 1 MB image as ~350 K tokens and force compaction every turn |
| Dropzone | Own dropzone component, replacing `ComposerPrimitive.AttachmentDropzone` | The primitive checks `thread.capabilities.attachments` and no-ops without an attachment adapter, and it only reacts to `DataTransfer` entries of type `Files` |
| Drop payload trust | An internal path drop is accepted only when a second `dataTransfer` entry carries this session's random token, each path passes `resolveSegments` and `stat`, and at most 20 paths are taken. `text/plain` is never read as a path | A page in another tab can set any custom `DataTransfer` type, so the payload is attacker-controlled text until validated |
| `@` completion | `unstable_useMentionAdapter` with `ComposerPrimitive.Unstable_TriggerPopover`, verified by a spike before the rest of Phase 4; a hand-rolled popover reading `selectionStart` off the textarea is the fallback | The caret is never published to composer state — `ComposerInput` hands `selectionStart` only to the plugin registry (`ComposerInput.tsx:381-386,415-426`) — so a hand-rolled `@` trigger has to reach into the DOM and restore the caret after `setText`. The adapter and its popover both exist in the installed 0.15.20, unlike when the slash popover was written |
| Mention index | `fs.list('', { recursive: true, glob })`, excluding `DEFAULT_EXCLUDED_DIRS`, dot-directories, and a secret deny-list, cached per `WorkspaceFs` | `fs.search` matches file **content**, never names (`src/workspace/search.ts:160-171`), while `list` already compiles a glob against the path (`src/workspace/fs.ts:218-219`). Without exclusions one `node_modules` exhausts the 1000-entry cap before `src/` is reached |
| Secret deny-list | `.env*`, `*.pem`, `*.key`, `id_*`, `.netrc`, `.npmrc` are hidden from the index, never auto-attached, and never inlined | `extensionOf('.env')` returns `''` because its guard is `dot > 0` (`src/ui/file-view/kind.ts:39-44`) and `kindForPath` then falls back to `'text'`, so without this they would inline verbatim |
| Inline classification | The extension must be known (`kindForExtension` non-null) **and** in the inlineable set, and the first 8 KB must pass `probeBinary` | `kindForPath` falls back to `'text'` for every unknown extension (`kind.ts:62-65`), which would otherwise pass a `.bin`, a `.wasm`, or an extensionless binary straight into `readFile`'s lossy UTF-8 decode |

## Phases

| # | Phase | Status | Depends on |
|---|-------|--------|------------|
| 1 | [Phase 1: Workspace blob write](./phase-01-blob-write.md) | Completed | — |
| 2 | [Phase 2: Attachment core and send path](./phase-02-attachment-core.md) | Completed | — |
| 3 | [Phase 3: Chip bar, upload button, dropzone](./phase-03-composer-ui.md) | Completed | 1, 2 |
| 4 | [Phase 4: `@` mention and tree drag](./phase-04-mention-and-drag.md) | Completed | 2, 3 |

Phases 1 and 2 touch disjoint files and may run in parallel. Phases 3 and 4 are sequential after them.

## Architecture

```
composer chips (attachment-store, keyed by threadId)
  + button ──────┐
  @ mention ─────┤
  tree drag ─────┼──▶ Attachment[] { id, kind, path, source, bytes }
  user-opened ───┘              │
  file (not `authored`)         │ Enter
                                ▼
                  queue: snapshot chips at enqueue,
                  clear manual chips, drain later
                                │
                                ▼
            resolveAttachments(fs, threadId, snapshot)
                                │
            ┌───────────────────┼────────────────────┐
            ▼                   ▼                    ▼
     inline text block    file part (image)    reference marker
     fenced with nonce    data URL ≤ 1 MB      reference | unchanged
                                │              | missing | denied
                                ▼
              engine.sendTurn(threadId, text, extra)
                                │
                     UIMessage.parts + metadata.attachments
```

Resolution order inside `resolveAttachments`:

1. A chip whose thread is no longer the bound thread aborts the whole resolution; the turn sends its text alone with an error surfaced.
2. A folder becomes a reference marker carrying up to 50 child names from `fs.list(path, { maxEntries: 50 })`.
3. An `auto`-sourced chip always becomes a reference marker, never inline content.
4. A deny-listed path becomes a reference marker regardless of size.
5. An image with a media type in `IMAGE_MEDIA_TYPES` becomes a `file` part with a data URL at or under 1 MB, plus a reference marker; SVG falls through to the text path.
6. An inlineable file becomes a fenced inline block when its extension is known, `probeBinary` passes, it is at or under 32 KB, and the 128 KB per-message budget still has room.
7. Everything else becomes a reference marker.
8. A path already inlined with the same hash by an earlier user message in the window becomes `mode: "unchanged"`, whose text also instructs the model to `read_file` the path if the content is not visible above.

## Files

| Path | Action | Purpose |
|---|---|---|
| `src/workspace/fs.ts` | Modify | `writeWorkspaceBlob`, `uniqueUploadPath`, `sanitizeUploadName` |
| `src/workspace/fake-handle.ts` | Modify | Store file content as bytes so a binary round-trip is testable |
| `src/workspace/fs.test.ts` | Modify | Blob write, size cap, name sanitizing, collision suffixing |
| `src/chat/attachments.ts` | Create | Types, caps, classification, fencing, send-time resolution |
| `src/chat/attachments.test.ts` | Create | Inline/reference split, fencing escapes, budget, suppression, folders |
| `src/chat/attachment-store.ts` | Create | Per-thread chip list, auto-attach follow, capture-and-clear |
| `src/chat/attachment-store.test.ts` | Create | Add, dedupe, remove, capture, thread switch, auto disable |
| `src/chat/engine.ts` | Modify | `sendTurn` takes resolved parts, records metadata, suppresses after compaction |
| `src/chat/sanitize.ts` | Modify | `ChatMessageMetadata.attachments` |
| `src/chat/reducer.ts` | Modify | Drop `metadata.attachments` when an edit replaces the parts |
| `src/chat/usage.ts` | Modify | Bounded per-image token estimate for `file` parts |
| `src/chat/queue.ts` | Modify | Snapshot chips at enqueue, widen `dispatch` |
| `src/chat/use-chat-runtime.ts` | Modify | Wire capture and resolution through the queue |
| `src/ui/attachment-bar.tsx` | Create | Compact chip row inside the composer shell |
| `src/ui/composer-dropzone.tsx` | Create | Native file drop, validated internal path drop, upload routine |
| `src/ui/composer-controls.tsx` | Modify | `+` upload button with a readwrite permission gate |
| `src/ui/mention-suggestions.tsx` | Create | `@` popover |
| `src/ui/mention-index.ts` | Create | Per-`fs` cached path index with exclusions |
| `src/ui/mention-index.test.ts` | Create | Exclusions, deny-list, cap, ranking |
| `src/ui/panels/workspace.tsx` | Modify | Draggable tree rows with the session token |
| `src/components/assistant-ui/elements/thread.aui.tsx` | Modify | Swap the dropzone, mount the chip bar, label queued attachments |

## Success Criteria

- [ ] Uploading a `.png` and a `.csv` writes both under `uploads/`, and `read_file` reads the `.csv` afterwards.
- [ ] Two files picked in one batch named `a.png` produce `uploads/a.png` and `uploads/a-1.png`.
- [ ] A file whose content is `</attached>` followed by a fake notice survives with no closed fence, and a file named `</attached-folder>` inside an attached folder is escaped in the listing.
- [ ] Typing `@eng` offers `src/chat/engine.ts`, and completing it adds a chip.
- [ ] A dropped payload of 500 paths, or one containing `../`, adds no chip and reports why.
- [ ] `presentWorkspace('.env')` produces no auto chip; `openWorkspace('README.md')` does, and that chip resolves to a reference marker rather than inline content.
- [ ] Attaching in thread A and switching to thread B leaves no chips, and a send immediately after a switch never resolves against the previous folder.
- [ ] Editing a user message that carried attachments clears `metadata.attachments`, so the next turn re-inlines rather than claiming `unchanged`.
- [ ] A turn that suppresses a path and auto-compacts in the same run still tells the model how to recover the content.
- [ ] A 1 MB image raises the estimated context by roughly 1.4 K tokens, not 350 K, and does not trigger auto-compaction on its own.
- [ ] After the assistant replies to a turn carrying a 5 KB attachment, the thread's measured usage includes it.
- [ ] With a pending approval and three chips, the approval prompt, chip row, input, and context meter are all fully visible at the narrowest composer width.
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risks

| Risk | Mitigation |
|---|---|
| Untrusted bytes impersonate the user or a system rule | Per-turn nonce fence plus body neutralization, covered by an injection fixture test |
| The model steers its own output into the next user turn | The auto chip skips `authored` paths and never inlines |
| Secrets inlined by accident | Deny-list hidden from the index, never auto-attached, never inlined; unknown extensions never inline |
| Image data URLs bloat IndexedDB and every later request | 1 MB cap, plus a criterion measuring the second turn after an image. Two consequences stay on the record: a rejected `put` surfaces as a failed turn (`src/chat/engine.ts:902`, `:773-785`), so a streamed answer is lost on reload; and an image that survives into a compaction is sent to the summarizer as well (`src/chat/compact.ts:43`) |
| An edited user message shows the raw inlined block | Editing lifts the notice, the fenced block, and the question into the edit box as one blob (`default-edit-composer-runtime-core.ts:58-70`), and the attachment parts are dropped on save. The plan accepts that: an edit drops attachments, and Phase 2 clears the records so the next turn re-inlines rather than claiming `unchanged` |
| A provider rejects a `file` part | Only the four raster media types are sent as `file` parts; everything else is a reference marker |
| Upload fails after a reload because the handle is read-only | `+` queries `readwrite` permission and routes to `regrant()`; resolution reports `WorkspacePermissionError` as a `denied` marker instead of losing the turn |
| Two files with the same name in one batch race | The batch writes sequentially with a create-exclusive probe; the residual cross-tab TOCTOU is documented, not claimed away |
| The `unstable_useMentionAdapter` API changes or does not fit the external-store runtime | Phase 4 begins with a bounded spike; the hand-rolled popover with a DOM caret is the fallback, and the decision is recorded before the rest of the phase is built |
| Uploads bypass the workspace journal | Documented: `restore` does not undo user uploads, matching the existing user-edit write path |

## Out of scope

- Attaching a remote URL.
- Previewing attachment content inside the chip.
- Re-attaching or repairing attachments on an edited message; an edit drops them.
- An assistant-ui `AttachmentAdapter` and its attachment UI primitives.
- Journalling user-initiated writes.

## Red team review

Three adversarial reviewers (assumption, failure-mode, security) checked every `file:line` claim in the first draft. Every finding they raised carried codebase evidence and was accepted. The blocking ones were: the send path targeted `onNew`, which the queue makes unreachable; the chip list was global while the workspace is per thread; `<attached>` was an unauthenticated delimiter; and the auto chip followed model-initiated previews. Their verified-correct list is also recorded, so later work does not re-litigate it: `sendTurn` has two non-test callers, `persistence.ts` has no metadata whitelist, `kind.ts` is React-free, `convertToModelMessages` accepts a `file` part with a `data:` URL, `resolveSegments` blocks root escape, and the transcript renders an image through `<img>`, which is not a script sink.

## Validation log

Four decisions were put to the user after the red-team pass; all four confirmed the drafted choice, so no phase changed.

| Question | Answer |
|---|---|
| Image data URL cost | Cap at 1 MB and accept the persistence and per-turn resend cost |
| `@` implementation | Spike `unstable_useMentionAdapter` first; hand-rolled popover is the fallback |
| Upload destination | Fixed `uploads/` at the workspace root |
| Secret files | Hidden from the `@` index and never inlined; an explicit drag still yields a reference marker |

## Post-review fixes

A `code-reviewer` pass over the finished implementation returned three blocking
defects and several silent data-loss paths. All are fixed, each with a test.

| Finding | Fix |
|---|---|
| A resolution failure destroyed the user's typed turn — the composer clears its draft before `dispatch` runs, so a rejection lost the message | `resolveAttachments` now degrades **every** error to a `missing` marker, and the dispatch catches `AttachmentsDroppedError` and still sends the text alone |
| `production.env`, `secrets.env`, and `.envrc` inlined verbatim: the deny-list anchored on `.env` as a prefix and `env` was in the inlineable extension list | Pattern widened to `/(^|\.)env(rc)?($|\.)/i` plus `/\.env$/i`, and `env` removed from `TEXT_EXTENSIONS` |
| The auto chip crossed conversations, because the File panel is global while the workspace folder is per thread | The store records which thread opened the current target (`autoOwner`) and the chip is offered to that thread alone |
| The mid-flight guard compared thread ids, but `bindThread` moves `boundThreadId` synchronously and adopts the new `fs` only after an await | The snapshot carries the `WorkspaceFs` it was captured against, compared by identity at dispatch |
| A slash command captured and discarded the chips | `capture` receives the text and declines for slash input, leaving the chips in the composer |
| Editing a queued message lost its chips | The queue wrapper re-keys the snapshot onto the edited message |
| The dispatch-transform hop was an untested assumption about library internals | A queue test installs a transform that re-spreads the message |
| Native drops and picks were unbounded | 20 files and 25 MB per file, reported rather than silently attempted |
| A glob query of `*`/`?` backtracked over the whole tree | Wildcards stripped from the fallback query |
| Bidi overrides survived `neutralize` and could reorder a marker visually | Stripped alongside the C0 controls |
| The attachment notice re-billed every turn while the File panel was open | The notice rides only when a fenced block is actually present |
| A 1 MB image URL was hashed on every send for a suppression path that never reads it | Image records carry no hash |
| Chips attached before a session's first send were orphaned under the empty key | They are adopted by the thread that send creates, along with a dismissed auto chip |
| `sanitizeUploadName` stripped non-Latin names down to their extension | Unicode letters and digits are kept |

Not addressed, deliberately: the working tree still mixes this feature with the
earlier compaction-indicator work (`src/chat/store.ts`, `src/ui/context-meter.tsx`,
`src/ui/compaction-indicator.tsx`), which belongs in its own commit.

## Composer highlighting

Follow-up request, outside the plan's original scope: a completed slash command
and an attached `@` mention are coloured in the composer.

A textarea cannot colour part of its own value, so `src/ui/composer-highlight.tsx`
paints a mirror layer underneath it — same box, same typography, scroll-synced —
while the textarea renders transparent glyphs and keeps its native caret,
selection, and placeholder. `src/ui/composer-highlight-state.ts` decides what is
*completed*: a slash name that resolves against the live registry, and a mention
whose path is actually attached as a chip. A half-typed `/comp` or an `@src/ch`
stays plain, so the colour states that the thing exists rather than decorating
whatever was typed.

## Remote URL drag and clipboard paste

Follow-up request, outside the plan's original scope, which listed "attaching a
remote URL" as out of scope.

Dragging an image or a link out of another page carries no `Files`, only a
`text/uri-list` entry (with `text/html` as a fallback for the dragged
`<img src>`/`<a href>`), so the dropzone now accepts `text/uri-list` alongside
`Files` and the internal path payload. `parseDropUrls` keeps only well-formed
`http(s)` URLs — never `javascript:`, `data:`, or `file:` — dedupes them, and
caps one drop at ten. `fetchUrlIntoWorkspace` fetches each link
`{ mode: "cors", credentials: "omit" }` with a 30 s timeout, names it from its
path segment (or the announced media type), writes it into `uploads/` through
the existing `uniqueUploadPath`/`writeWorkspaceBlob`, and attaches it as an
ordinary file chip. A site that sends no CORS headers fails with a named error
instead of a silent no-op; a body over the 25 MB cap is refused from
`content-length` before it is read. A non-vision model still refuses image
links, matching the native-file rule. Links are fetched sequentially, because
two identical names probed in parallel would both look free.

Pasting is the same upload path: a `paste` on the composer shell takes
`clipboardData.files` (a screenshot or a file copied from Finder) and leaves a
text paste to its native behavior.

## Images in the transcript

Follow-up request: an attached image showed twice without ever showing the
picture — a `File` card with the filename, size, and a download button inside
the bubble, plus a `mode: "image"` badge above it.

`UserFilePart` now returns `null` for an `image/*` part and `UserImagePart`
returns `null`, and `UserMessageImages` draws the picture itself, right-aligned
above the bubble, through the existing `ImageRoot`/`ImageZoom`/`ImagePreview`
elements. `UserAttachmentBadges` drops records whose mode is `image`, so the
redundant badge is gone while a marker-only image (`reference`, `missing`,
`denied`) still surfaces as a badge because it has no file part to render.



