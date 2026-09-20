---
title: Planned harness artifact preview
date: 2026-09-20
summary: "Brainstormed and planned an open_preview tool plus an isolated artifact HTML runtime and Markdown/JSON/Mermaid viewers, through a 15-finding red-team review."
---

# Planned harness artifact preview

## What happened

The user asked whether the model could create an artifact in a session and auto-open a preview on the File panel, and to propose features. Scouting found the seam already exists: `src/session/file-view-state.ts` holds a `FileTarget` store and `src/ui/shell.tsx:273` subscribes to reveal the `files` rail panel. Missing pieces were a tool that reaches the UI and three viewers.

Brainstorm chose approach A: artifacts are workspace files, reusing every existing viewer. New `PreviewPort` in `ToolRuntimePorts`, a builtin `open_preview` tool, and Markdown/JSON/Mermaid viewers.

Plan authored at `plans/260920-1246-harness-artifact-preview/` (4 phases).

## Red team

Three hostile reviewers (security, assumptions, failure modes) produced 15 evidence-backed findings, all accepted. The most important:

- `origin` on `FileTarget` recorded the opener, not the author, so model-authored HTML regained `allow-same-origin` on a user reopen. Replaced with a sticky `authored` set plus a store-level `revision`.
- Requiring `origin`/`revision` on `FileTarget` broke `kind.test.ts:53` and `pnpm build`. Avoided entirely by keeping `FileTarget` unchanged.
- Revision-keyed remount discarded unsaved edits on a user re-click. User same-path opens are now no-ops.
- `close_preview` would clear a file the user opened. Dropped.
- A persisted `deny` cannot apply to a non-gated tool (`src/chat/approval.ts:18`); the overstated claim was removed.
- Production CSP (`vite.config.ts:32-55`) blocks inline scripts in local-scheme documents, so a dev-only browser gate would prove nothing.
- Mermaid SVG injection needed DOMPurify, a single init, and a hostile-label test.
- `.jsonc` cannot parse with `JSON.parse`; dropped.

## Decision

Validation added a new Phase 1 "Artifact HTML Runtime": a spike plus decision gate to render model-authored HTML via a blob-URL document with externalized inline scripts and, if required, a narrow `frame-src 'self' blob:` / `script-src 'self' blob:` CSP delta. `'unsafe-inline'` is never added. If no mechanism works, the gate escalates with accept/scope/separate-origin options. Mermaid viewer included. Model opens always reload.

## Next steps

Run `/ak:cook plans/260920-1246-harness-artifact-preview/plan.md`. Phase 1 must land the runtime and record dev and production browser evidence before Phase 2's authored branch.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
