---
title: "File Panel Viewers — Local Files and Links"
description: "Turn the File panel from a text-only Monaco editor into a type-aware viewer: text/code editing, images, audio, video, HTML preview, CSV, XLSX, DOCX, and remote links routed from a URL bar and clickable chat/markdown links."
status: implemented
priority: P1
effort: 16h
branch: main
tags: [feature, ui, workspace, media, security]
created: 2026-09-20
---

# File Panel Viewers — Local Files and Links

## Overview

The File panel only renders text through Monaco (`src/ui/panels/file-editor.tsx:38`).
Opening a binary file decodes it as UTF-8 text (via `WorkspaceFs.readFile`), and
there is no path to open a remote link at all. This plan introduces a
type-aware `FileTarget` model and a viewer dispatcher so the panel opens the
content types the product needs: text/code, images, audio, video, HTML (preview
plus source), CSV, XLSX, and DOCX — for workspace files and for remote links.

Remote links get a URL bar in the panel and are also reachable by clicking
http(s) links in chat markdown. A harness `view_url` tool is intentionally out of
scope and can be layered on the same target store later.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | One `FileTarget` model (`workspace` path or `url`) with kind detection by extension | P1 |
| 2 | Workspace binary read path (`readWorkspaceBlob`) with a size cap, separate from the text cap | P1 |
| 3 | Viewers: text/code (Monaco, editable), image, audio, video, HTML preview+source, CSV, XLSX, DOCX | P1 |
| 4 | URL bar in the File panel opens http(s) links; unknown types fall back to a sandboxed embed with an open-in-new-tab escape | P1 |
| 5 | Chat/markdown http(s) links route into the File panel | P1 |
| 6 | Link targets are limited to http(s), parse and fetch are size-capped, and HTML preview runs scripts in a sandbox (same-origin enabled by explicit product decision) | P1 |
| 7 | `pnpm test`, `pnpm lint`, `pnpm build` stay green | P1 |

## Contract

**Outcome.** Selecting a file in the Workspace tree, or entering/clicking a link,
opens it in the File panel with the renderer that matches its type. Text and code
stay editable with Save; HTML has Preview and Source modes; media renders with
native controls; CSV/XLSX render as tables; DOCX renders with document styling;
unknown remote links render in a sandboxed iframe with an open-in-new-tab escape.

**Constraints.**

- Browser-only, no Node APIs. Adds two pinned dependencies, both lazily imported
  so they never enter the initial chunk: `docx-preview@0.4.0` and SheetJS
  `xlsx@0.20.3` (installed from the official `cdn.sheetjs.com` tarball; the npm
  registry `latest` is `0.18.5`, which is unpatched for prototype-pollution and
  ReDoS advisories and therefore rejected for untrusted input).
- `WorkspaceFs` keeps its public shape. Binary reads are a free function
  `readWorkspaceBlob(fs, path, { maxBytes })` in `src/workspace/fs.ts`, so no
  existing mock in the test suite has to grow a member.
- `FileTarget` lives in `src/session/file-view-state.ts` (zustand), consumed by
  the shell, the File panel, and the markdown anchor renderer. No other state
  layer is introduced.
- Input policy: only `http`/`https` targets are accepted; binary parse and fetch
  are size-capped. HTML preview is script-enabled (`allow-scripts`) and, by
  explicit product decision, also `allow-same-origin` for both workspace files
  and remote links.
- `pnpm test`, `pnpm lint`, `pnpm build` stay green.

**Non-goals.**

- A harness `view_url` tool (explicitly deferred by the user; the target store is
  the seam it will use).
- PDF rendering, office _editing_, or saving DOCX/XLSX.
- Opening arbitrary OS files outside the chosen workspace folder.
- Relative markdown links resolved against the workspace (only explicit http(s)
  links route to the panel).
- Server-side fetch/proxy for CORS-blocked remote documents; a clear error is
  shown instead.

**Acceptance criteria.**

1. `kindForPath`/`kindForExtension` map image, audio, video, html, csv/tsv,
   xlsx/xls, docx, and unknown→text; `kindForRemote` maps unknown→embed.
2. `normalizeRemoteInput` accepts bare hosts, `http(s)://`, and `//` forms, and
   rejects `javascript:`, `data:`, empty, and non-http(s) schemes.
3. `readWorkspaceBlob` returns a `Blob`, rejects a missing file, and throws
   `WorkspaceLimitError` above the cap.
4. The File panel renders each kind with its viewer; text/code saves back to the
   workspace; HTML toggles Preview/Source; CSV and XLSX render as tables; DOCX
   renders as styled pages.
5. Clicking an http(s) link in chat opens it in the File panel; modifier-click
   and non-http(s) links keep default behavior.
6. `javascript:`/`data:` targets are rejected; previewed HTML runs scripts and,
   by explicit product decision, shares an origin with its content (app origin
   for workspace `srcdoc`, remote origin for links).
7. `pnpm test`, `pnpm lint`, `pnpm build` pass.

## Key Decisions

- **Kind by extension, not MIME.** Workspace `File` objects frequently carry an
  empty `type`; extension is the only reliable signal. Unknown workspace types
  stay text (editable), unknown remote types become `embed` (iframe).
- **Viewer per kind, no mega-switch in one file.** Each viewer owns its loading
  and controls; the panel header stays generic (label, kind badge, close).
- **`readWorkspaceBlob` as a function, not an interface method.** Keeps nine
  hand-written `WorkspaceFs` mocks unchanged.
- **Lazy imports for `docx-preview` and `xlsx`.** Both are large; the chat
  surface must not pay for them.
- **Sandbox with `allow-same-origin` (product decision).** HTML preview and
  remote embeds run scripts and keep a usable origin: workspace files rendered
  with `srcdoc` share the app origin, remote links keep the remote origin. This
  unlocks modules, `fetch`, storage, and workers. Accepted trade-off: previewed
  workspace HTML can reach app-origin storage and the parent DOM, and
  `allow-scripts` + `allow-same-origin` lets the frame drop its own sandbox, so
  only trusted HTML should be previewed.
- **All http(s) chat links route to the panel.** Known types render richly;
  unknown types show the embed with an open-in-new-tab fallback. Modifier-click
  preserves new-tab behavior.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Dependencies, `readWorkspaceBlob`, target model, kind detection, file-view store | Implemented |
| 2 | Viewers and File panel dispatcher with URL bar | Implemented |
| 3 | Chat link routing, tests, lint/build verification | Implemented |

Phases are sequential: Phase 2 consumes the target model and store from Phase 1;
Phase 3 wires the last entry point and verifies the whole.

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Extends | `plans/260919-1437-chat-interface` (File panel) | implemented |
| Consumes | `src/workspace/fs.ts`, `src/session/workspace-state.ts` | — |
| Blocked by | none | — |

## Risk Summary

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| A crafted XLSX/DOCX from a remote link exploits a parser | Medium × High | Patched SheetJS 0.20.3 from the official source; size caps; parsing runs in the browser tab only, never against stored state |
| Previewed HTML reaches app storage or parent DOM | Medium × High | Accepted by product decision: `allow-same-origin` is enabled for workspace HTML and remote embeds; scripts in previews are treated as trusted input |
| A remote document is blocked by CORS | High × Low | Explicit error message; open-in-new-tab remains available for pages |
| Opening a large media file exhausts memory | Low × Medium | `DEFAULT_BINARY_SIZE_CAP` on workspace reads and a fetch cap on remote reads |
| Object URLs leak across file switches | Medium × Low | `useObjectUrl` revokes on cleanup; each viewer unmounts on target change |

## Validation Log

### Decision Session 1 — 2026-09-20

| # | Question | Decision |
|---|----------|----------|
| 1 | How far should HTML preview scripting go? | All HTML: add `allow-same-origin`, accepting that previewed HTML can reach app-origin storage and the parent DOM. The user was shown the trade-off and chose full capability over opaque-origin isolation. |

Propagation: Goal 6, the input-policy constraint, acceptance criterion 6, the
sandbox key decision, and the "previewed HTML reaches app storage" risk row were
all updated to match.

## Success Criteria

- [x] Goals 1-7 implemented; kind detection, URL normalization, and
      `readWorkspaceBlob` have automated tests.
- [x] Workspace text editing still round-trips through `fs.writeFile`.
- [x] `pnpm test`, `pnpm lint`, `pnpm build` pass.

## Implementation Results

Implemented across all three phases.

Gate evidence at completion:

- `pnpm test`: 66 files, 673 passed, 1 skipped.
- `pnpm lint`: clean.
- `pnpm build`: green. `docx-preview` (171 kB) and `xlsx` (492 kB) emit as
  separate lazy chunks and never enter the initial chunk.

Files:

- `src/workspace/fs.ts` — `DEFAULT_BINARY_SIZE_CAP`, `readWorkspaceBlob`.
- `src/session/file-view-state.ts` — `FileTarget` and the zustand store.
- `src/ui/file-view/` — `kind.ts`, `language.ts`, `load.ts`, `spreadsheet.ts`,
  `use-text-document.ts`, `sandbox.ts`, `feedback.tsx`, `table.tsx`, and the
  `text`/`html`/`image`/`media`/`sheet`/`docx`/`embed` viewers.
- `src/ui/panels/file-editor.tsx` — `FilePanel` dispatcher with the URL bar.
- `src/ui/shell.tsx` — store-driven target; subscribes to reveal the panel.
- `src/components/assistant-ui/elements/markdown-text.tsx` — http(s) link routing.

Tests: `src/ui/file-view/kind.test.ts`, `src/ui/file-view/spreadsheet.test.ts`,
`src/session/file-view-state.test.ts`, and new `readWorkspaceBlob` cases in
`src/workspace/fs.test.ts`.

Residual (browser-only, not run here): rendering each viewer against real files
in Chromium, remote CORS-blocked downloads, and large-file streaming via object
URLs.
