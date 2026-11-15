---
phase: 6
title: CSP, docs, and verification
status: in-progress
priority: P2
effort: 1h
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6 — CSP, docs, and verification

## Goal

The production policy allows the gallery's `blob:` images, the docs describe the playground, its providers, and its egress, and every gate passes, including the hardened proxy on a Vercel preview.

## Files

- Modify:
  - `vite.config.ts`: `img-src 'self' data: blob:` (`:45`), with the reason added to the CSP doc comment.
  - `src/settings/DataEgressNotice.tsx`: playground providers in what leaves the machine (`:23`).
  - `README.md`: Features, Your data, Troubleshooting, Development `src/` map.

## Steps

1. **CSP.** Add `blob:` to `img-src` only. A `blob:` URL can only be minted by same-origin script, and images cannot run script, so `script-src` is not weakened. This also fixes the existing `useObjectUrl` previews in production.
2. **Egress copy.** With a provider token set, prompts, parameters, and input images go to that provider through its same-origin path. Larger input images are uploaded to the provider's file storage and stay there until the provider expires them. Outputs are downloaded from the provider's file host.
3. **README.**
   - Features: one Playground bullet naming Replicate as the first provider.
   - Your data: the deployment relays `/replicate/v1/*` to `api.replicate.com` and image paths under `/replicate-files/` to `replicate.delivery` without storing anything; the token is sent from the browser.
   - Hosts other than Vercel must provide the same rewrites and headers, or the user sets a base URL in Config. Mention the optional Vercel WAF rate-limit rule.
   - Development: `playground/` in the `src/` map, with one sentence on how to add a provider (adapter module, registry entry, rewrite).
4. **Gates.**
   - `pnpm exec vitest run`
   - `rtk proxy pnpm exec tsc -b`
   - `pnpm lint`
5. **Live checks (only with the user's go-ahead and token).**
   - Dev server (already running): flux-schnell; flux-kontext-pro with an input above 256 KB; `prunaai/z-image-turbo`; Cancel mid-run; lock mid-run, then unlock and watch it resume.
   - Vercel preview:
     - the same runs;
     - `Authorization` reaches Replicate (a run works) and `x-vercel-cache` is not `HIT` on `/replicate/v1/*`;
     - `curl -I` on a `/replicate-files/<sub>/<path>.webp` URL shows the sandbox CSP, `Content-Disposition: attachment`, `nosniff`, and `no-store`;
     - `curl -I` on a `/replicate-files/<sub>/<path>.html` URL does not proxy.
   - If the hardened headers do not apply to the rewrite response, remove the `/replicate-files` rewrite from `vercel.json` before shipping and tell the user.
   - Record the observed 402, 422, and 404 bodies if they occur, and adjust `fromHttp` if they differ.

## Verification

- All three gates pass, with output recorded in the plan's implementation notes.
- Each live check is recorded with its result, or marked not run with the reason.
