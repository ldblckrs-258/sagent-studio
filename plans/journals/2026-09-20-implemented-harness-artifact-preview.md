# Implemented: Harness Artifact Preview

Plan: `plans/260920-1246-harness-artifact-preview/plan.md`

## Implementation Summary (2026-09-20)

All four phases are implemented; node gates are green.

- Commands: `pnpm lint` clean, `pnpm test` green (71 files, 708 passed / 1
  skipped), `pnpm build` clean (`tsc -b` + Vite).
- Lazy chunks confirmed: `mermaid.core-*.js`, per-diagram chunks, and
  `purify.es-*.js` are separate; the entry `index-*.js` contains no DOMPurify.
- Production CSP delta is exactly `script-src 'self' blob:` and
  `frame-src 'self' blob:`; `'unsafe-inline'` was not added.
- New modules: `src/ui/file-view/{artifact-html-transform.ts,
  artifact-html-runtime.tsx, viewer-mode-toggle.tsx, json.ts, json-view.tsx,
  markdown-view.tsx, diagram.ts, diagram-view.tsx}`,
  `src/tools/builtin/preview.ts`.
- Changed modules: `src/session/file-view-state.ts` (`revision`, `authored`,
  `presentWorkspace`, `targetKey`), `src/session/session.ts` (`PreviewPort`,
  provider registration, introspection), `src/tools/types.ts` (`PreviewPort`),
  `src/tools/approval.ts` (`open_preview` read-only), `src/chat/engine.ts`,
  `src/ui/panels/file-editor.tsx`, `src/ui/file-view/{sandbox,kind,html-view}.tsx`,
  `vite.config.ts`, `package.json`, `plans/README.md`.

## Deviations

- The pure HTML transform lives in `artifact-html-transform.ts`, not
  `artifact-html-runtime.ts`. A `.ts` and a `.tsx` with the same basename made
  `./artifact-html-runtime` resolve to the extension-less `.ts` first and broke
  the component import; renaming the transform removed the collision.
- `sanitizeDiagramSvg` is async and dynamically imports DOMPurify, so DOMPurify
  stays out of the entry chunk (the plan requires it to be a lazy chunk). The
  test awaits accordingly.
- `formatJsonDocument` was dropped. It had no consumer in the tree viewer and a
  test-only existence; the JSON viewer needs no pretty-printed string.

## Review Disposition

A `code-reviewer` pass found one real defect and two improvements, all applied:

1. Sticky-authorship bypass via a non-canonical path alias. `presentWorkspace`
   and `openWorkspace` now canonicalize through `resolveSegments`, so a model
   presenting `./a/b.html` records `a/b.html` and a later tree reopen cannot
   downgrade it to the same-origin preview. Covered by a store test.
2. The JSON sibling cap allocated every sibling before slicing. Bounded
   allocation moved into `jsonChildren`, covered by a 200k-element array test.
3. Documented the self-contained-artifact constraint (no inline handlers,
   `javascript:` URLs, remote/relative scripts or assets) in the transform, the
   runtime, and the spike report.

## Browser gate — PENDING

The Phase 1 decision gate and the Phase 4 end-to-end browser checklist require
`pnpm dev` and `pnpm build && pnpm preview` in a real browser. This session ran
node-only, so both are recorded as pending rather than claimed. The hostile
fixture and expected observations are in
`reports/artifact-html-runtime-spike.md`. Known risk to verify: WebKit and Chrome
on iOS have blocked `blob:`-src scripts inside sandboxed iframes; if the gate
fails there, the blob mechanism needs replacement (separate origin or a nonce
policy), not a broader CSP.
