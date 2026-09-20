---
title: "Harness Artifact Preview"
description: "Give the model an open_preview tool so an artifact it writes to the workspace opens automatically in the File panel, render model-authored HTML in an isolated runtime, and widen the panel with Markdown, JSON, and Mermaid viewers."
status: implemented
priority: P1
effort: 25h
branch: main
tags: [feature, ui, tools, security]
created: 2026-09-20
---

# Harness Artifact Preview

## Overview

The File panel already auto-opens when `useFileViewStore` gets a target: `shell.tsx:273` subscribes and reveals the rail. Today only the Workspace tree, the URL bar, and chat markdown links set that target. The model has no way to present its output. This plan adds a harness `open_preview` tool plus a `PreviewPort`, so a model that writes an artifact (`write_file`) can immediately open it in the panel. It also renders model-authored HTML in an isolated runtime and fills the viewer gaps the artifact use case needs: Markdown, JSON, and Mermaid diagrams.

Artifacts are workspace files (decided in brainstorm). `FileTarget` is unchanged — the revision counter and model-authorship provenance live in the file-view store, and the existing file-view store remains the seam.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Model-authored HTML renders in an isolated runtime that cannot reach app storage or the parent DOM, verified in dev and production | P1 |
| 2 | Model can open a workspace file in the File panel via an `open_preview` tool | P1 |
| 3 | A model-initiated open reloads the viewer even for the already-open path; a user re-click of the active file does not remount or discard edits | P1 |
| 4 | Model-presented HTML keeps its isolated runtime across a later user reopen | P1 |
| 5 | File panel renders Markdown (rich preview + source) | P1 |
| 6 | File panel renders JSON (tree + source) | P1 |
| 7 | File panel renders Mermaid diagram source (`.mmd`/`.mermaid`) | P1 |
| 8 | `pnpm test`, `pnpm lint`, `pnpm build` stay green | P1 |

## Contract

**Outcome.** During a turn, the model writes a file and calls `open_preview`; the File panel reveals itself and shows the file in the correct viewer. Calling `open_preview` again on the same path reloads the content. A user-opened file keeps today's behavior, and a file the model has presented keeps its isolated runtime even if the user later opens it from the tree.

**Constraints.**

- Browser-only; no Node APIs.
- Approach A from the brainstorm: artifact = workspace file. Requires a granted workspace folder; `open_preview` fails cleanly when there is none.
- `FileTarget` keeps its `{ kind: 'workspace'; path } | { kind: 'url'; url }` shape. `revision` and `authored` are store state, not target fields, so no existing target literal changes.
- Tools reach the UI only through a new `PreviewPort` in `ToolRuntimePorts`, injected at the composition root (`session.ts`). No tool imports a UI store directly.
- `open_preview` is a navigational, non-gated tool call (it performs a read-only `stat` and sets a UI target). It is auto-approved in `read_only`, `editing`, and `god`. A persisted `deny` does **not** apply, because `chat/approval.ts:18` consults policy only for gated tools — this is documented, not claimed away. Disk writes stay behind the already-gated `write_file`.
- Model-authored HTML sandboxing applies to paths the model has **presented** this session (`authored`), not merely to the open action, so a later user reopen cannot upgrade the trust level.
- The production CSP is a real constraint: `vite.config.ts:32-55` injects `default-src 'self'` and `script-src 'self'`, and local-scheme documents (`about:srcdoc`, `blob:`, `data:`) inherit the creator's policy. Phase 1 must prove the artifact runtime's script behavior under the production build; the plan does not assume it works because dev does.
- `react-markdown`, `mermaid`, and `dompurify` are added as dependencies. Mermaid is lazily imported so it never enters the initial chunk.
- `pnpm test`, `pnpm lint`, `pnpm build` stay green.

**Non-goals.**

- Artifacts outside the granted workspace folder.
- A `close_preview` tool (dropped: it would let the model clear a file the user opened).
- A dedicated artifact store, version history, or an artifacts rail panel.
- Persisting model-authorship provenance across sessions (it is session-scoped and resets on reload).
- PDF rendering; DOCX/XLSX editing; DOCX/XLSX artifact generation.
- Share links, download bundles, or server-side rendering of artifacts.
- Live streaming preview while the model is still generating the file.
- Changing the sandbox policy for user-opened files that the model has never presented.

**Acceptance criteria.**

1. `open_preview` is offered when a workspace folder is granted; `open_preview` on a missing path returns a `toolFail` envelope and does not change the target.
2. Calling `open_preview` sets the workspace target and bumps `revision`; a model re-open of the active path still bumps it and reloads. A user `openWorkspace` call for the already-active path is a no-op.
3. A path the model presented is recorded in `authored`; HTML for an authored path renders in the Phase 1 isolated runtime, including when the user later opens that path from the tree. A user-opened, never-presented HTML file keeps `PREVIEW_SANDBOX`.
4. The isolated runtime executes HTML scripts (or, if Phase 1's decision gate resolves otherwise, records the accepted behavior) and cannot read app-origin storage or the parent DOM, in dev and in the production build.
5. `.md`/`.markdown` render as formatted Markdown with a Source toggle; `.json` renders as a tree with a Source toggle and a sibling cap; `.mmd`/`.mermaid` render as a sanitized diagram with an error fallback.
6. `kindForPath`/`kindForExtension` return the new kinds; unknown extensions still fall back to `text`.
7. `open_preview` resolves to `approved` in `read_only`, `editing`, and `god`.
8. The runtime, viewer behavior, and `HtmlView` branching have automated tests.
9. `pnpm test`, `pnpm lint`, `pnpm build` pass, and `pnpm build` shows Mermaid in a lazy chunk.

## Key Decisions

- **Workspace files, not a virtual artifact store.** Reuses every existing viewer and the disk persistence the vault already trusts. Trade-off: without a folder grant there is no artifact, which the tool reports honestly.
- **New `PreviewPort` at the composition root.** Tools stay UI-free; `session.ts` is already the composition root and already reads workspace state. Trade-off: one more port in `ToolRuntimePorts`.
- **Sticky authorship, not opener identity.** The store keeps an `authored` set of paths the model has presented; the HTML runtime derives from that set. This closes the reopen-upgrade hole a per-call `origin` flag leaves open. Trade-off: the set is session-scoped and resets on reload.
- **An isolated artifact HTML runtime, proven against the production CSP.** A `srcdoc` document cannot carry a policy distinct from the parent, so the default candidate is a blob-URL document with inline scripts externalized to blob scripts and a narrow `blob:` CSP delta. If no mechanism runs scripts without `'unsafe-inline'`, Phase 1's decision gate escalates instead of weakening the policy.
- **Two open paths with different reload semantics.** `presentWorkspace` (model) always bumps `revision`; `openWorkspace` (user) is a no-op for the active path, so re-clicking the tree cannot remount an editor and discard unsaved edits.
- **No `close_preview`.** Closing could blank a file the user opened, and the model gains nothing the user's own close button does not do.
- **Revision counter over a file watcher.** Bumping an integer and remounting the viewer is enough to refresh after a rewrite; no watch infrastructure.
- **`react-markdown` pinned to the already-resolved 10.1.0.** It is present transitively under `@assistant-ui/react-markdown@0.14.15`; adding it directly keeps the resolved version and avoids a second copy.
- **Mermaid lazy, strict, sanitized, initialized once.** `securityLevel: 'strict'`, an exact pinned version, a single module-level init, and DOMPurify on the returned SVG before injection.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Artifact HTML Runtime](./phase-01-artifact-html-runtime.md) | Implemented |
| 2 | [Preview Tool and Authored-Sandbox Target](./phase-02-preview-tool.md) | Implemented |
| 3 | [Markdown and JSON Viewers](./phase-03-viewers.md) | Implemented |
| 4 | [Diagram Viewer and End-to-End Verification](./phase-04-diagram-and-verification.md) | Implemented |

Phase 1 is a prerequisite for Phase 2's authored branch. Phase 3 and Phase 4 add viewers that the Phase 2 dispatcher routes to, and Phase 4 closes with the full gate.

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Extends | `plans/260920-0900-file-panel-viewers` (File panel, target store) | implemented |
| Extends | `plans/260919-1821-harness-tools` (tool result envelopes, approval gates) | implemented |
| Consumes | `src/tools/types.ts`, `src/chat/engine.ts`, `src/session/session.ts`, `src/session/file-view-state.ts`, `vite.config.ts` | — |
| Blocked by | none | — |

## Risk Summary

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Model-authored HTML reaches app-origin storage or the parent DOM | Medium × High | Sticky `authored` set plus an isolated runtime; a user reopen cannot upgrade trust |
| No runtime mechanism executes HTML scripts without `'unsafe-inline'` | Medium × High | Phase 1 spike plus a decision gate with accept/scope/separate-origin options; the plan never silently relaxes `script-src` |
| A model that presents several paths pulls the user out of the active panel | Medium × Low | Accepted: revealing the panel is the feature. No debounce; the risk is stated, not dismissed |
| A model-initiated reload of the active path discards an in-progress edit | Low × Medium | Only model opens force a reload; user re-clicks are no-ops |
| A large Mermaid dependency bloats the initial bundle | Medium × Medium | Lazy `import('mermaid')` inside the diagram viewer; verify it emits as its own chunk in `pnpm build` |
| Mermaid SVG carries script from a crafted label | Low × High | Strict security level, exact version pin, DOMPurify on the SVG, and a hostile-label test |
| Adding `blob:` to `script-src` weakens XSS defense | Medium × Low | Narrow, documented delta; `'self'` stays, `'unsafe-inline'` is never added |
| JSON tree freezes on a wide document under the size cap | Medium × Medium | Cap rendered siblings per level with a "show more" control; add a large-array test |
| `open_preview` on a nonexistent or directory path | Medium × Low | `workspace.stat` gate before setting the target; return `toolFail` |

## Red Team Review

### Session — 2026-09-20

**Findings:** 15 (15 accepted, 0 rejected)
**Severity breakdown:** 2 Critical, 5 High, 8 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `origin` tagged the opener, not the author; model HTML regained `allow-same-origin` on user reopen | Critical | Accept | plan.md Key Decisions/Goals; Phase 2 steps 1,4 |
| 2 | Required `FileTarget` fields broke `kind.test.ts:53` and `pnpm build` | Critical | Accept | plan.md Constraints; Phase 2 step 1 (revision/authored moved off `FileTarget`) |
| 3 | Revision-keyed remount discarded unsaved edits on a user re-click | High | Accept | Phase 2 step 1 (user same-path no-op) |
| 4 | `close_preview` cleared the user's panel and was auto-approved | High | Accept | plan.md Non-goals; Phase 2 (tool dropped) |
| 5 | Persisted `deny` never applied to non-gated tools; acceptance claim was false | High | Accept | plan.md Constraints/Acceptance 7 |
| 6 | `approval.test.ts` exact read-only set assertion would go red | High | Accept | Phase 2 step 9 |
| 7 | `kind.test.ts:46` remote `.md` assertion would go red | High | Accept | Phase 3 step 8 |
| 8 | `builtinProviders` hardcoded provider array omitted the tool | Medium | Accept | Phase 2 step 7 |
| 9 | `.jsonc` could never parse under strict `JSON.parse` | Medium | Accept | Phase 3 step 2 |
| 10 | Mermaid SVG injected raw; global mutable init; no hostile-label test | Medium | Accept | Phase 4 steps 1,3 |
| 11 | Production CSP blocks inline scripts; browser gate env-dependent | Medium | Accept | Phase 1 (spike + decision gate); plan.md Contract/Criteria 4 |
| 12 | JSON tree rendered unbounded siblings | Medium | Accept | Phase 3 steps 4,5 |
| 13 | Phase 4 cited the lazy-import precedent in the wrong module | Medium | Accept | Phase 4 Context Links |
| 14 | `plans/README.md` stale count and wrong "Plan 4/6" dependency | Medium | Accept | Phase 4 step 8 |
| 15 | `HtmlView` sandbox selection had no render test | Medium | Accept | Phase 2 step 9 (`html-view.test.tsx`) |

### Whole-Plan Consistency Sweep

- Files reread: plan.md, phase-01-artifact-html-runtime.md, phase-02-preview-tool.md, phase-03-viewers.md, phase-04-diagram-and-verification.md
- Decision deltas checked: 15 plus the Phase 1 addition from validation
- Reconciled stale references: `close_preview` removed everywhere; `origin` on `FileTarget` replaced by store-level `authored`/`revision`; `jsonc` removed; "Plan 4/6" corrected to Plan 5/6; a new Phase 1 moved the runtime work and all later phases were renumbered
- Unresolved contradictions: 0

## Validation Log

### Decision Session 1 — 2026-09-20

| # | Question | Decision |
|---|----------|----------|
| 1 | Diagram rendering needs a large Mermaid dependency (plus DOMPurify, jsdom dev) | Include the Mermaid viewer now; lazy-loaded, exact-pinned, sanitized |
| 2 | HTML artifact sandbox vs production CSP | Pursue a blob-URL / own-origin HTML runtime instead of accepting the `srcdoc` CSP caveat; added Phase 1 with a spike and a decision gate |
| 3 | Model open of a path the user is mid-editing | Model open always reloads; user re-clicks are no-ops |
| 4 | Next step after validation | Plan only; stop for `/ak:cook` |

Propagation: Goal 1, Contract, Acceptance 4, Key Decisions, Phases, Dependencies, and Risk Summary reflect the Phase 1 addition. Phase 1 was created and phases renumbered; every cross-reference was updated.

## Success Criteria

- [x] Goals 1-8 implemented with the isolated runtime, the tool, sticky authorship, and three viewers.
- [ ] The runtime decision is recorded with dev and production evidence; `open_preview`, store reload semantics, kind mapping, runtime transform, and JSON parsing have automated tests. (Automated tests done; the dev + production browser evidence is recorded as pending in `reports/artifact-html-runtime-spike.md`.)
- [x] `pnpm test`, `pnpm lint`, `pnpm build` pass, and `pnpm build` shows Mermaid in a lazy chunk.
