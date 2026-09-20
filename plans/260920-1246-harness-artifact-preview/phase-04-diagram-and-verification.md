---
phase: 4
title: "Diagram Viewer and End-to-End Verification"
status: implemented
priority: P1
effort: "4h"
dependencies: [2, 3]
---

# Phase 4: Diagram Viewer and End-to-End Verification

## Context Links

- `src/ui/file-view/kind.ts` — extension routing.
- `src/ui/file-view/sheet-view.tsx:16-19` and `src/ui/file-view/docx-view.tsx:24` — the real lazy-heavy-dependency precedent (`xlsx`, `docx-preview`).
- `src/ui/file-view/html-view.tsx` — the sandboxed-iframe precedent for untrusted content.
- `src/ui/panels/file-editor.tsx` — dispatch.
- `vite.config.ts:32-55` — the build-only CSP (`script-src 'self'`).
- `plans/README.md:3,15,16` — stale plan count and the Plan 5/6 rows.
- `vitest.config.ts:6` — `environment: 'node'`; the sanitize test needs a per-file `jsdom` pragma.

## Goal

Render Mermaid diagram artifacts from workspace source with sanitized output, then close the plan with the full test, lint, and build gate plus the plan-index update.

## Requirements

- Functional: `.mmd`/`.mermaid` files render as diagrams.
- Functional: invalid diagram source shows an error and still exposes the source view.
- Non-functional: `mermaid` is loaded lazily and never enters the initial chunk.
- Security: Mermaid is initialized once with `securityLevel: 'strict'`; the returned SVG is sanitized with DOMPurify before injection; a hostile-label test proves no script survives.
- Documentation: `plans/README.md` lists this plan with the correct count and dependency.
- Verification: the browser gate is run against both `vite dev` and the production build, and the CSP constraint is recorded.

## Architecture

A new `diagram` kind routes `.mmd`/`.mermaid` to `DiagramView`. It loads source through `useTextDocument`/`useRemoteText`, lazily imports `mermaid` once through a memoized module-level initializer, renders to an SVG string, sanitizes it with DOMPurify, and injects it. A Source toggle exposes the raw text and editing for workspace targets. This is the last viewer; the phase ends with the whole-repo gate.

## Related Code Files

Create:

- `src/ui/file-view/diagram.ts` — memoized Mermaid init + `sanitizeDiagramSvg`.
- `src/ui/file-view/diagram.test.ts` — sanitize/hostile-label tests (jsdom pragma).
- `src/ui/file-view/diagram-view.tsx` — the viewer.

Modify:

- `package.json` — add `mermaid` and `dompurify` (and `jsdom` as a devDependency).
- `src/ui/file-view/kind.ts` — `diagram` kind + extensions + label.
- `src/ui/file-view/kind.test.ts` — diagram expectations.
- `src/ui/panels/file-editor.tsx` — dispatch branch.
- `plans/README.md` — plan row, count, and dependency.

## Implementation Steps

1. Add dependencies, pinning versions once resolved:
   - `pnpm add mermaid dompurify` then record the **exact** resolved versions in `package.json` (no caret) so a minor upgrade cannot silently change sanitizer behavior.
   - `pnpm add -D jsdom` for the sanitize test.
   - Confirm with `pnpm why mermaid dompurify`.

2. In `src/ui/file-view/kind.ts`, add `'diagram'` to `FileKind`, `DIAGRAM_EXTENSIONS = new Set(['mmd', 'mermaid'])`, map it in `kindForExtension`, and add `diagram: 'Diagram'` to `KIND_LABELS`.

3. Create `src/ui/file-view/diagram.ts`:

   ```ts
   let renderer: Promise<typeof import('mermaid')> | null = null
   export function loadMermaid(): Promise<typeof import('mermaid')> {
     renderer ??= import('mermaid').then((mod) => {
       mod.default.initialize({ startOnLoad: false, securityLevel: 'strict' })
       return mod
     })
     return renderer
   }

   export function sanitizeDiagramSvg(svg: string): string {
     return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
   }
   ```

   Initializing once at module level avoids re-initializing global Mermaid config on every render. `securityLevel: 'strict'` plus DOMPurify is defense in depth: strict governs Mermaid's label handling, DOMPurify is an independent sanitizer for the generated SVG.

4. Create `src/ui/file-view/diagram-view.tsx`:
   - Load source with `useTextDocument(fs, workspacePath)` (workspace) or `useRemoteText(remoteUrl)`, following `text-view.tsx`.
   - Default mode `preview`. Hold render state `{ svg: string } | { error: string } | { loading: true }`.
   - In an effect keyed on the source and mode, when mode is `preview`:
     ```ts
     const mermaid = await loadMermaid()
     const { svg } = await mermaid.default.render(`diagram-${idRef.current++}`, source)
     setState({ svg: sanitizeDiagramSvg(svg) })
     ```
     Guard with a `cancelled` flag so a superseded render does not set state; catch and store the error message.
   - Render the sanitized `svg` with `dangerouslySetInnerHTML` inside a padded, scrollable container.
   - On error show `ViewerError` plus the source via `MonacoEditor`.
   - Source mode: `MonacoEditor` (no dedicated Mermaid language; use `plaintext`), editable with the save bar for workspace targets.
   - Include the shared `ViewerModeToggle`.

5. Update `src/ui/file-view/kind.test.ts` with `expect(kindForExtension('mmd')).toBe('diagram')`, `expect(kindForExtension('mermaid')).toBe('diagram')`, and `expect(kindLabel('diagram')).toBe('Diagram')`.

6. Create `src/ui/file-view/diagram.test.ts` with `// @vitest-environment jsdom` at the top (the repo default is `node`, which has no DOM for DOMPurify):
   - `sanitizeDiagramSvg` strips a `<script>` node and `onerror`/`onload` handlers from an SVG string containing a hostile label.
   - `sanitizeDiagramSvg` preserves benign SVG structure (a `<rect>`/`<text>` survives).
   - `loadMermaid` initializes with `securityLevel: 'strict'` and `startOnLoad: false` (spy on `mermaid.initialize` or assert the returned config path).

7. Update `src/ui/panels/file-editor.tsx` with `{kind === 'diagram' ? <DiagramView fs={fs} target={target} /> : null}`.

8. Update `plans/README.md`: add row 7 to the index table for `260920-1246-harness-artifact-preview` (status `pending`, depends on Plan 5 and Plan 6) and one sequencing sentence stating it extends the File panel with a model-facing `open_preview` tool and Markdown/JSON/Mermaid viewers. Correct the intro count sentence (`plans/README.md:3`) so it matches the row count.

9. Run the full gate and confirm the Mermaid chunk:

   ```bash
   pnpm test
   pnpm lint
   pnpm build
   ```

   Inspect the build output: `mermaid` and `dompurify` must appear in a viewer chunk, not the entry chunk.

10. Browser gate. Run it against **both** `vite dev` and the production build, because the build injects `script-src 'self'` (`vite.config.ts:35,48`) and a `srcdoc` iframe inherits the parent CSP — inline scripts in an artifact that run in dev can be blocked in the built app. Record:
    - a `.mmd` file opened from the tree and via a model `open_preview` call renders;
    - an invalid diagram shows the error and the source;
    - a model-presented `.html` file cannot read app-origin `localStorage`, in dev and in the production build;
    - a never-presented `.html` file still runs scripts with the existing sandbox.
    Record the CSP constraint (HTML artifacts should be self-contained; the opaque-origin sandbox is the operative control) and any environment-limited gate as pending in the implementation journal.

## Verification

```bash
pnpm vitest run src/ui/file-view/kind.test.ts src/ui/file-view/diagram.test.ts
pnpm test
pnpm lint
pnpm build
```

## Todo

- [ ] Add `mermaid`, `dompurify`, and `jsdom`; pin exact versions.
- [ ] Add the `diagram` kind, extensions, and label.
- [ ] Create `diagram.ts` with single init + DOMPurify sanitize.
- [ ] Create `diagram-view.tsx` with lazy load, error fallback, and source toggle.
- [ ] Wire the dispatch branch.
- [ ] Add `diagram.test.ts` with the jsdom pragma and hostile-label cases.
- [ ] Update `kind.test.ts` and `plans/README.md`.
- [ ] Pass `pnpm test`, `pnpm lint`, `pnpm build`; confirm the lazy chunk.
- [ ] Run the dev + production browser gate or record it as pending.

## Success Criteria

- `.mmd`/`.mermaid` files render as sanitized diagrams, or show a clear error with source.
- A hostile label cannot inject a script node or event handler into the app document.
- Mermaid and DOMPurify do not enter the entry chunk.
- `pnpm test`, `pnpm lint`, and `pnpm build` pass.
- `plans/README.md` lists the plan with the correct status, dependency, and row count.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Mermaid's dynamic import is tree-shaken into the entry chunk | Verify chunk names in `pnpm build` output; lazy-import only inside `diagram.ts` |
| A Mermaid patch changes sanitizer behavior | Pin exact versions; DOMPurify is an independent second layer; hostile-label test guards regressions |
| A render race sets stale SVG on fast source changes | `cancelled` guard in the effect and a unique render id per call |
| DOMPurify has no DOM under the repo's `node` test env | `jsdom` devDependency and a `// @vitest-environment jsdom` pragma on the diagram test file |
| A very large diagram stalls the render thread | Source is size-capped by the read limits; note streaming/perf as a follow-up if observed |
| Build-CSP blocks inline scripts that work in dev | Documented; browser gate runs against dev and the production build |

## Security Considerations

- Diagram source is untrusted model output; `securityLevel: 'strict'` and no raw HTML labels are mandatory, and DOMPurify sanitizes the returned SVG before injection into the app document.
- The Mermaid initializer runs once so a user tool or second viewer cannot reset the security level mid-session.
- Remote `.mmd` targets stay read-only.

## Next Steps

On completion the plan is implementation-ready via `/ak:cook`; record browser-only gates in the implementation journal if they cannot be run in the current environment.
