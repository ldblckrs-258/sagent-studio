---
phase: 1
title: "Artifact HTML Runtime"
status: implemented
priority: P1
effort: "6h"
dependencies: []
---

# Phase 1: Artifact HTML Runtime

## Context Links

- `src/ui/file-view/html-view.tsx:94-100` — the current `srcdoc` preview and its sandbox.
- `src/ui/file-view/sandbox.ts:1-10` — `PREVIEW_SANDBOX` and the `allow-same-origin` product decision.
- `vite.config.ts:32-55` — the build-only CSP meta tag (`default-src 'self'`, `script-src 'self'`).
- `plans/260920-0900-file-panel-viewers/plan.md` — the prior "previewed HTML can reach app storage" accepted risk, which this phase narrows for model-authored content.
- MDN, CSP guide: documents with local schemes (`about:srcdoc`, `blob:`, `data:`) inherit the creator's policy container.

## Goal

Establish and implement the rendering mechanism for model-presented HTML so its scripts can run, its content cannot reach the app origin, and the production CSP behavior is known and verified rather than assumed.

## Requirements

- Functional: `ArtifactHtmlRuntime` renders an HTML string with scripts enabled.
- Security: the runtime uses a sandbox without `allow-same-origin`; the rendered document cannot read app-origin storage or the parent DOM.
- Verification: the mechanism is proven in **both** `vite dev` and the production build, because the build injects `script-src 'self'` and local-scheme documents inherit it.
- Non-functional: the chosen CSP delta, if any, is the narrowest change that works and is documented with its trade-off; `'unsafe-inline'` is not added.
- Non-functional: blob URLs are revoked to avoid leaks.

## Architecture

The spike determines the mechanism; the default candidate is a **blob-URL document** because a `srcdoc` document cannot be given a distinct policy from the parent:

```
artifact html string
  └─ transform: inline <script>…</script> → <script src=blob:…>   (keeps execution order)
        └─ <iframe src={blobUrl} sandbox="allow-scripts allow-forms allow-popups allow-modals">
              ├─ opaque origin (no allow-same-origin) → no app storage / parent DOM
              └─ CSP: local-scheme doc inherits creator policy
                    → requires frame-src 'self' blob: and script-src 'self' blob:
```

If the spike shows that inline scripts cannot execute even with the blob transform and a narrow CSP delta, the phase escalates with the three options below instead of weakening `script-src` with `'unsafe-inline'`.

## Related Code Files

Create:

- `src/ui/file-view/artifact-html-runtime.tsx` — the runtime component.
- `src/ui/file-view/artifact-html-runtime.ts` — pure transform + sandbox constant (testable without React).
- `src/ui/file-view/artifact-html-runtime.test.ts` — transform and sandbox tests.
- `plans/260920-1246-harness-artifact-preview/reports/artifact-html-runtime-spike.md` — spike evidence.

Modify:

- `src/ui/file-view/sandbox.ts` — add `ARTIFACT_PREVIEW_SANDBOX`.
- `vite.config.ts` — the narrow CSP delta, only if the spike requires it.
- `src/ui/panels/file-editor.tsx` — route authored HTML targets to the runtime (Phase 2 does the actual branch wiring; this phase lands the component).

## Implementation Steps

1. Build a throwaway spike (a temporary component or a scratch route) that renders a hostile HTML fixture:
   ```html
   <div id="out">ok</div>
   <script>
     try { localStorage.setItem('probe', 'x'); document.title = 'APP STORAGE REACHED' }
     catch (e) { document.getElementById('out').textContent = 'blocked: ' + e.name }
   </script>
   ```
   Render it through three candidates, each with `sandbox="allow-scripts allow-forms allow-popups allow-modals"`:
   - A: `srcdoc` (baseline),
   - B: `blob:` URL (`new Blob([html], { type: 'text/html' })`),
   - C: `data:text/html,<encoded>`. 

2. Run each candidate under `pnpm dev` and under `pnpm build && pnpm preview`. For each, record whether the inline script executed, whether `localStorage` threw, and whether the frame could touch `parent.document`. Capture console CSP violations. Write the results to `reports/artifact-html-runtime-spike.md` with the exact commands.

3. Decision gate. Pick the first candidate that (a) executes scripts under the production CSP and (b) is blocked from app storage and the parent DOM.
   - If candidate B works only after a CSP delta, apply the narrow delta in `vite.config.ts`: add `frame-src 'self' blob:` and `script-src 'self' blob:`. Keep `'self'`; never add `'unsafe-inline'`.
   - If inline scripts still cannot run without `'unsafe-inline'`, stop and present the user with: (i) accept artifacts without executable inline scripts and keep the strictest CSP, (ii) add `'unsafe-inline'` scoped by a nonce/hash for the artifact document only (not achievable with a single static meta policy), or (iii) defer to a follow-up plan that serves artifacts from a separate origin. Record the decision in the spike report. Do not proceed to Phase 2 on an unresolved gate.

4. Create `src/ui/file-view/artifact-html-runtime.ts`:
   ```ts
   export const ARTIFACT_PREVIEW_SANDBOX =
     'allow-scripts allow-forms allow-popups allow-modals'
   /** Rewrites inline scripts to external blob scripts so `script-src 'self' blob:` permits them. */
   export function externalizeInlineScripts(html: string): { html: string; urls: string[] }
   export function revokeAll(urls: readonly string[]): void
   ```
   `externalizeInlineScripts` uses `DOMParser` to find `<script>` elements without `src`, replaces each with a `<script src>` created from a `Blob` of its text (preserving order), and returns the rewritten string plus the created URLs. It must leave `<script src>` and `<script type="application/json">` untouched. This helper is pure enough to unit test when given a `URL.createObjectURL` stub.

5. Create `src/ui/file-view/artifact-html-runtime.tsx`: given `{ html: string }`, run `externalizeInlineScripts` (memoized on `html`), create a blob URL, render `<iframe src={blobUrl} sandbox={ARTIFACT_PREVIEW_SANDBOX} referrerPolicy="no-referrer" title="Artifact preview" />`, and revoke every created URL on cleanup.

6. Add `src/ui/file-view/artifact-html-runtime.test.ts` (node env is fine; stub `URL.createObjectURL`/`revokeObjectURL`):
   - `externalizeInlineScripts` rewrites one inline script to an external `src`, leaves `<script src>` and `type="application/json"` untouched, and preserves order across two inline scripts.
   - `revokeAll` calls `URL.revokeObjectURL` for each URL.
   - `ARTIFACT_PREVIEW_SANDBOX` does not contain `allow-same-origin`.

7. Record the chosen mechanism and the CSP delta (if any) in the spike report and in the plan's Key Decisions.

## Verification

```bash
pnpm vitest run src/ui/file-view/artifact-html-runtime.test.ts
pnpm lint
pnpm build
```

Browser gate (required, not optional):

```bash
pnpm dev            # record script execution + storage block
pnpm build && pnpm preview   # record the same under the production CSP
```

## Todo

- [ ] Write the hostile fixture and run the three candidates in dev and prod.
- [ ] Record results and the decision in `reports/artifact-html-runtime-spike.md`.
- [ ] Apply the narrow CSP delta only if required.
- [ ] Add `ARTIFACT_PREVIEW_SANDBOX` and `externalizeInlineScripts`/`revokeAll`.
- [ ] Add `ArtifactHtmlRuntime` with blob URL + cleanup.
- [ ] Add the transform tests.
- [ ] Pass the focused vitest, `pnpm lint`, `pnpm build`, and the dev+prod browser gate.

## Success Criteria

- The spike report states, with commands and observed output, whether each candidate executes scripts and whether it is blocked from app storage in dev and production.
- The implemented runtime runs scripts and cannot reach app storage or the parent DOM.
- `'unsafe-inline'` is not added; any CSP delta is limited to `blob:` for frames/scripts and is documented with its trade-off.
- The transform tests, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Blob/data documents inherit the app CSP, so no candidate runs inline scripts | The spike proves this before implementation; the decision gate offers accept/scope/separate-origin options instead of silently weakening CSP |
| Adding `blob:` to `script-src` weakens XSS defense | Documented trade-off; `'self'` stays and `'unsafe-inline'` is never added; only app-generated blob URLs are used |
| A transform bug breaks artifact scripts or ordering | Pure helper with unit tests covering order, external scripts, and non-JS script types |
| Blob URLs leak across renders | `revokeAll` on every cleanup; covered by a test |
| `srcdoc`/blob behavior differs between browsers | Browser gate runs Chromium; note other engines as a follow-up if needed |

## Security Considerations

- The runtime is the trust boundary for model-authored HTML; opaque origin plus a strict CSP is the control.
- The transform only reads artifact text and creates blob scripts from it; it never evaluates artifact content inside the app document.
- Any CSP change is a security-relevant decision recorded in the spike report and the plan, not an incidental edit.

## Next Steps

Phase 2 branches model-presented HTML targets to this runtime and adds the `open_preview` tool and store semantics.
