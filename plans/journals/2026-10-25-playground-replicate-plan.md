---
title: Playground (Replicate image) plan
date: 2026-10-25
summary: Planned a provider-based Playground view with Replicate first; red team caught a same-origin XSS through the file proxy and an orphaned-prediction billing hole.
---

# Playground (Replicate image) plan

## What happened
- Planned the Playground feature in hard mode. The plan is at `plans/261025-2148-playground-replicate-image/`: 6 phases, about 21h.
- Research confirmed that `api.replicate.com` sends no CORS headers, so a same-origin proxy is required. Vercel external rewrites time out after 120 s and are undocumented on header pass-through and body size.
- Production `/typesafe` and deep paths already return 404, and there is no `vercel.json`.
- From this machine every connection to `*.replicate.delivery` is reset, so output-download CORS could not be checked.
- The red team (3 reviewers) found 28 findings, merged into 18. The critical one: the planned `/replicate-files` rewrite would serve model-generated HTML or SVG on the app origin, where the meta-tag CSP does not apply.
- Other high findings:
  - `Prefer: wait` hid the prediction id, so Cancel and lock left paid predictions running.
  - Image bytes in the run row would load on every unlock.
  - `fetchLimitedBlob` could not abort or retry.
  - The Vite `/replicate` key swallowed `/replicate-files`.
  - `useWorkspaceStore.pick()` would rebind the open conversation's folder.

## Decision
- A provider contract plus registry, with Replicate as the first adapter (user asked for extensibility mid-planning).
- Create-then-poll with `Cancel-After: 10m`. The prediction id is saved at once, and runs resume after unlock within 55 min.
- Runs and images are split into two encrypted tables. History hydrates on the first Playground mount, capped at 200 runs and 1 GiB.
- Direct output download first, with a hardened `/replicate-files` fallback limited to image extensions, sandbox CSP, attachment, nosniff, and no-store. The fallback is removed if a Vercel preview shows the headers do not apply.
- A Playground-owned save folder (`playground:folder`). The conversation workspace is never touched.

## Next steps
- `/ak:cook plans/261025-2148-playground-replicate-image/plan.md`
- Phase 1 step 0: check `replicate.delivery` reachability and CORS in the user's browser.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
