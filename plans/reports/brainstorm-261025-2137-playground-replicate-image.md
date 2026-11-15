---
type: brainstorm
date: 2026-10-25
topic: Playground view, first surface image generation and editing on Replicate
status: accepted
---

# Brainstorm: Playground, Replicate image generation and editing

## Summary

A new top-level **Playground** view sits beside Chat in the shell. The first playground runs any Replicate image model: the user picks a model by `owner/name` or from a curated quick-list, a form is built from the model's OpenAPI input schema, input images can be attached for editing, and results land in an encrypted vault history with download and "Save to workspace" actions. The browser reaches Replicate through a same-origin `/replicate` proxy provided by the Vite dev/preview server and a `vercel.json` rewrite in production.

## Evidence (current state)

- `api.replicate.com` sends no CORS headers. A preflight `OPTIONS /v1/predictions` from `https://sagent-studio.vercel.app` returns 200 with no `Access-Control-Allow-Origin`, so direct browser calls fail.
- The app is a static bundle with no backend (README). The only proxy precedent is `/typesafe` in `vite.config.ts` (dev and preview only). Production `https://sagent-studio.vercel.app/typesafe/` returns 404 and the repo has no `vercel.json`, so that proxy is already missing in production.
- The production CSP (`cspPlugin` in `vite.config.ts`) sets `img-src 'self' data:` and `connect-src 'self' https: ...`. A remote `<img src="https://replicate.delivery/...">` is blocked; outputs must be fetched and rendered from `data:` (or `blob:` if added to `img-src`).
- Replicate output file URLs expire about an hour after the prediction is created, so durable results must be downloaded.
- Shell layout: `src/ui/shell.tsx` owns the sidebar, the conversation area, and a rail of `RailPanelId` panels. There is no top-level view switch today.
- Secrets: provider API keys live in vault settings (`src/vault/settings.ts`, `src/settings/ProvidersPanel.tsx`, `src/ai/secret-field.tsx`). Providers are OpenAI-compatible only.
- Vault: Dexie `sagent-vault` is at schema v8 (`src/vault/db.ts`). Per-record AES-GCM through `encryptRecord` / `decryptRecord` (`src/vault/records.ts`). `recover()` and `vaultInternals.reset` in `src/vault/store.ts` enumerate every table.
- An image viewer already exists under `src/ui/file-view/`.

## Decisions (accepted)

1. **Placement: top-level view.** The shell gains a Chat | Playground switch. Playground gets a full-width canvas, with parameters on the left and a results gallery on the right, and leaves room for later playground types.
2. **Transport: host rewrite.** A `/replicate` same-origin path proxies to `https://api.replicate.com` through `server.proxy` and `preview.proxy` in `vite.config.ts` and a rewrite in a new `vercel.json`. Output downloads go through a second path (for example `/replicate-files`) to `https://replicate.delivery`. There is no server code; the token travels per request in the `Authorization` header and is never stored on the host.
3. **Models: any model, schema-driven form.** The model is resolved with `GET /v1/models/{owner}/{name}`, and the form is generated from `latest_version.openapi_schema` → `components.schemas.Input`. A curated quick-list (for example flux-schnell, flux-dev, flux-kontext-pro, nano-banana, seedream) only pre-fills the model field.
4. **Persistence: encrypted vault history plus save.** Outputs are downloaded and stored, together with model, prompt, and params, in a new vault table (Dexie v9). Each result offers Download and Save to workspace.

## Outcome

- The user stores a Replicate API token once (encrypted in the vault, editable in Config).
- In Playground the user chooses a model, fills the generated form, optionally attaches input images, and clicks Run.
- Progress shows starting, processing, and done or failed, with Cancel. Finished images appear in the gallery and stay there after reload or lock and unlock.
- Each history entry can be re-run, have its params copied back into the form, be downloaded, be saved into the granted workspace folder, or be deleted.

## Design sketch

### Replicate client (`src/replicate/` or `src/playground/replicate/`)

| Call | Endpoint |
|------|----------|
| Verify token | `GET /v1/account` |
| Resolve model and schema | `GET /v1/models/{owner}/{name}` |
| Run official or latest model | `POST /v1/models/{owner}/{name}/predictions` with `Prefer: wait=60` |
| Run a pinned version | `POST /v1/predictions` with `version` |
| Poll | `GET /v1/predictions/{id}` until `succeeded`, `failed`, or `canceled` |
| Cancel | `POST /v1/predictions/{id}/cancel` |
| Large input file | `POST /v1/files` (multipart), then pass `urls.get` |

- Small input images go inline as `data:` URIs. Larger ones go through the Files API. The exact inline size threshold must be confirmed against current Replicate docs during planning.
- Outputs can be a string URL, an array of URLs, or other JSON. v1 renders image URLs and shows anything else as JSON.

### Schema form

- Supported field types: `string` (with `enum` as a select and `format: uri` as an image input), `integer` and `number` (with `minimum` and `maximum` as a slider plus number input), and `boolean`. Fields keep the `x-order` ordering and use `default` and `description` as help text.
- `prompt` is pinned at the top. Unsupported shapes fall back to a raw JSON field.

### Data

- Dexie v9 adds `playgroundRuns: 'id, createdAt'`. The row is `{ id, blob, createdAt }` with everything else inside the ciphertext, under AAD `playground:<id>`, following the memories pattern.
- Envelope: `{ version: 1, run: { id, model, versionId?, input, status, error?, outputs: [{ mime, bytes }], metrics?, createdAt } }`. Input images are stored as-is so a run can be reproduced.
- `recover()` and `vaultInternals.reset` must include the new table.
- Storage quota: image bytes are large. The existing `StorageWarning` pattern applies, and history should be capped or prunable.

### Settings

- A Replicate token field in Config (a new section, not an OpenAI-compatible provider entry), using `secret-field.tsx`. It is checked with `GET /v1/account` on save.
- `DataEgressNotice` and the README "What leaves your machine" section gain a Replicate line.

### Host config

- `vercel.json` rewrites `/replicate/:path*` → `https://api.replicate.com/:path*` and `/replicate-files/:path*` → `https://replicate.delivery/:path*`. The broken production `/typesafe` rewrite can be added in the same file (optional, flagged).
- No CSP change is needed if outputs render as `data:` URLs. If `blob:` is preferred for memory, add `blob:` to `img-src` only.

## Options considered

| Area | Chosen | Rejected and why |
|------|--------|------------------|
| Placement | Top-level view | Rail panel: too narrow for forms and galleries. Chat tool only: gives no playground UX. |
| Transport | Host rewrite | Vercel Function: makes the app non-static for no v1 benefit. User proxy URL: poor UX, and every user needs their own proxy. |
| Models | Schema-driven any model | Curated hand-written forms: go stale and cost code for every model. |
| Persistence | Vault history plus save | Session only: loses work on reload. Workspace only: needs a folder grant just to keep anything. |

## Non-goals (v1)

- Video, audio, and text models on Replicate. The schema form may happen to run them, but only image output is rendered.
- Fine-tuning, trainings, deployments, and webhooks.
- Providers other than Replicate.
- Exposing generation to the chat agent as a tool. This is a natural follow-up that can reuse the same client.
- Streaming outputs (SSE) and multi-model side-by-side comparison.

## Acceptance criteria

1. With a valid token, `black-forest-labs/flux-schnell` generates an image from a prompt in `pnpm dev`, `pnpm preview`, and the production deployment.
2. An edit model (for example `black-forest-labs/flux-kontext-pro`) accepts an uploaded input image and returns the edited image.
3. A model typed by `owner/name` that is not in the quick-list renders its form from the schema and runs.
4. A prediction that takes longer than the `Prefer: wait` window finishes through polling, and Cancel stops it.
5. A missing, wrong, or out-of-credit token, an unknown model, and a failed prediction each show a specific error message, not a generic one.
6. History survives a reload and a lock/unlock cycle, is unreadable without the vault key, and is wiped by `recover()`.
7. Download and Save to workspace write the original image bytes with the correct extension.
8. The production CSP is unchanged except, optionally, `blob:` in `img-src`. `script-src` is untouched.
9. Unit tests cover the schema-to-form mapping, the prediction state machine (wait, poll, cancel, failure), and the vault envelope round-trip.

## Risks and unknowns

- **Body size through the rewrite.** The request body limit for Vercel external rewrites needs to be confirmed. Large data-URI inputs may exceed it; the Files API path covers that, but the file upload itself also passes through the proxy.
- **Header passthrough.** The plan must check that the Vercel rewrite forwards `Authorization` and `Prefer` and that a 60-second `Prefer: wait` does not hit a proxy timeout. If it does, use a short wait and poll.
- **Shared-host exposure.** The README warns against a public shared API-key proxy. This rewrite stores no key, but any site visitor could use `/replicate` with their own token. This is acceptable and should be documented.
- **Quota.** Many full-resolution images in IndexedDB can hit browser quota. Pruning and a size indicator are needed.
- **Schema variety.** Some models use `anyOf`, `allOf` refs, or file arrays. The JSON fallback field covers these, but forms will look uneven for such models.
