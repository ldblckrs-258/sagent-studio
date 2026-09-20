# Artifact HTML Runtime Spike

Phase 1 decision record for how model-authored HTML is rendered so its scripts
run while the document stays isolated from the app origin.

## Question

Which local-scheme document runs inline scripts under the production CSP
(`vite.config.ts` injects `default-src 'self'` and `script-src 'self'`) while
staying blocked from app-origin storage and the parent DOM?

## Constraint discovered first

Per the CSP spec, a document with a local scheme (`about:srcdoc`, `blob:`,
`data:`) inherits the policy container of its creator. So every candidate
inherits the app's production CSP, and **no candidate can run an inline
`<script>` under `script-src 'self'` without `'unsafe-inline'`.** The mechanism
had to allow scripts without adding `'unsafe-inline'`.

## Candidates

| # | Mechanism | Inherits CSP | Inline script under prod CSP | Opaque origin | Verdict |
|---|-----------|--------------|------------------------------|---------------|---------|
| A | `srcdoc` | yes | blocked | only without `allow-same-origin` | rejected: cannot externalize inline scripts to a permitted source |
| B | `blob:` URL with inline scripts externalized to blob scripts, narrow CSP delta | yes | runs with `script-src 'self' blob:` | yes (no `allow-same-origin`) | **chosen** |
| C | `data:text/html` | yes | runs visually, but `data:` needs its own delta and behaves worse in Safari | yes | rejected: weaker support, no benefit over B |

## Decision

Candidate **B**:

1. `externalizeInlineScripts` parses the artifact with `DOMParser` and replaces
   each executable inline `<script>` with `<script src="blob:…">` built from the
   same text, in document order. Data blocks (`type="application/json"`) and
   existing `<script src>` are untouched.
2. The transformed document is served from a `blob:` URL in an iframe with
   `sandbox="allow-scripts allow-forms allow-popups allow-modals"` — no
   `allow-same-origin`, so the frame gets an opaque origin.
3. The production CSP adds exactly `blob:` to `script-src` and `frame-src`. It
   keeps `'self'` and **never** adds `'unsafe-inline'`.

### Trade-off

`script-src 'self' blob:` is a narrow widening: a blob URL can only be minted by
same-origin script that is already executing, so it does not let injected text
become code. The opaque-origin sandbox is the operative control for the artifact
document; the CSP delta only permits the app's own generated blob URLs to load.

## Usability constraint

Only inline `<script>` elements are externalized. Because the artifact frame
runs under `script-src 'self' blob:` with no `'unsafe-inline'`, inline event
handlers (`onclick`), `javascript:` URLs, and remote or relative `<script src>`
and asset URLs do not execute, and the blob-URL base means relative paths do not
resolve. Artifacts must be self-contained; this is deliberate, not a defect.

## Automated evidence

```
pnpm vitest run src/ui/file-view/artifact-html-transform.test.ts
```

Covers the transform (single inline script, external script + JSON data block
untouched, order preserved across two scripts, module type preserved, empty
script skipped), `revokeAll`, and that `ARTIFACT_PREVIEW_SANDBOX` omits
`allow-same-origin`.

## Browser gate — pending

The plan's Phase 1 gate requires observing, in **both** `pnpm dev` and the
production build (`pnpm build && pnpm preview`), that the artifact frame runs
its script and that `localStorage` is blocked. This environment cannot launch
Chromium, so the gate is recorded as pending rather than claimed.

To close it, use the hostile fixture and cast:

```html
<div id="out">ok</div>
<script>
  try { localStorage.setItem('probe', 'x'); document.title = 'APP STORAGE REACHED' }
  catch (e) { document.getElementById('out').textContent = 'blocked: ' + e.name }
</script>
```

Expected in both environments: the frame shows `blocked: SecurityError`, the app
document's title is unchanged, and no `Refused to execute inline script` CSP
violation is logged for the artifact (its scripts are blob-served). A CSP
violation naming a `blob:` URL would mean the delta is insufficient.

## Security considerations

- The runtime is the trust boundary for model-authored HTML; opaque origin plus
  the strict CSP delta is the control.
- The transform reads artifact text and creates blob scripts from it; it never
  evaluates artifact content inside the app document.
- Blob URLs are revoked on every cleanup (`revokeAll` plus the document URL).
