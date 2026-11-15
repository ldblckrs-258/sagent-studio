---
title: Playground with Replicate implemented; outputs moved to R2
date: 2026-10-25
summary: "Implemented the provider-based Playground (Replicate first) with encrypted history; live tests found presigned R2 outputs without CORS, so a hardened /replicate-r2 relay was added."
---

# Playground with Replicate implemented; outputs moved to R2

## What happened

- Implemented all six phases of `plans/261025-2148-playground-replicate-image`:
  - a provider contract and registry;
  - vault-stored tokens behind `setPlaygroundProvider`;
  - a hardened OpenAPI-to-form mapper;
  - the Replicate adapter;
  - Dexie v9 tables `playgroundRuns` and `playgroundImages` with per-record AES-GCM;
  - a run lifecycle with resume after unlock;
  - a Chat | Playground switch in the shell.
- Live checks with the user's token confirmed:
  - the schemas of all 8 quick-list models;
  - the 404 and 422 `detail` bodies;
  - create-then-poll, and cancel;
  - an upload through `/v1/files`;
  - a flux-kontext-pro edit.
- The plan's assumptions about output hosting were wrong. flux-schnell outputs are now presigned Cloudflare R2 URLs (`ai-gateway-outputs.<account>.r2.cloudflarestorage.com/provider-outputs/<uuid>/<uuid>?X-Amz-*`) with no CORS headers and no file extension. A browser could never fetch them directly. kontext outputs still come from `replicate.delivery`, which this network resets.
- jsdom plus fake-indexeddb produce cross-realm `Uint8Array`s, which fail the `instanceof` guard in `decryptBytes`. The view test therefore uses an in-memory persistence. The encrypted DB path is tested in the node environment.
- Vitest swallowed `console.log` from a passing test, so the first live run spent credits and produced no output. Results now go to a scratchpad file.

## Decision

- Add a hardened `/replicate-r2/` relay in `vite-proxy.ts` and `vercel.json`, with:
  - a strict host and path pattern;
  - a required `X-Amz-Signature`;
  - sandbox CSP, attachment, nosniff and no-store headers.
- The user chose not to pin the R2 account id.
- Code review fixes, all with tests:
  - H1: signature required.
  - M1: cancel orphaned predictions when lock or delete happens during start.
  - M2: retry transient poll errors with backoff.
  - M3: a failed hydrate can be retried.
  - L1, L5 and L11.
- Gates: 2162 tests pass, and `tsc -b` and lint are clean.

## Next steps

- Restart `vite preview` (:4173) to load the new proxies, then run the browser checks.
- On a Vercel preview, confirm the hardened headers on external-rewrite responses and that the R2 query string passes through. Remove the file relays if the headers do not apply.
- Remaining low-severity review items are in `plans/reports/code-reviewer-261025-2330-playground-replicate.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
