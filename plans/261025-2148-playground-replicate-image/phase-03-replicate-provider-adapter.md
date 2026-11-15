---
phase: 3
title: Replicate provider adapter
status: completed
priority: P2
effort: 3h
dependencies: [1, 2]
---

# Phase 3 — Replicate provider adapter

## Goal

Replicate implements `PlaygroundProvider`: it resolves models and schemas, starts predictions and returns their id at once, polls, cancels, uploads inputs, and downloads outputs through the shared helper.

## Files

- Create:
  - `src/playground/providers/replicate/client.ts`
  - `src/playground/providers/replicate/index.ts`
  - `src/playground/registry.ts`
- Tests:
  - `src/playground/providers/replicate/client.test.ts`
  - `src/playground/providers/replicate/index.test.ts`
  - `src/playground/registry.test.ts`

## Steps

1. **HTTP client (`client.ts`).** `createReplicateHttp({ apiKey, baseURL, fetch })` with one `request(method, path, { body?, headers?, signal? })`:
   - sends `Authorization: Bearer <apiKey>` and `credentials: 'omit'`;
   - maps non-2xx responses with `fromHttp` (401, 402, 404, 413 → `too_large`, 422, 429);
   - maps a raw `TypeError` to `network` with a sentence naming the proxy path, like `src/mcp/errors.ts:20`;
   - passes every message through `redactToken`.
2. **Adapter (`index.ts`).** `replicateProvider: ProviderDefinition`:
   - `id: 'replicate'`, `label: 'Replicate'`, `tokenLabel: 'API token'`, `tokenUrl: 'https://replicate.com/account/api-tokens'`, `defaultBaseURL: '/replicate'`, `retentionMs: 55 * 60_000`.
   - `quickModels`: `black-forest-labs/flux-schnell`, `black-forest-labs/flux-kontext-pro`, `black-forest-labs/flux-2-pro`, `google/nano-banana`, `google/nano-banana-pro`, `bytedance/seedream-4.5`, `google/imagen-4`, `prunaai/z-image-turbo`. `prunaai/z-image-turbo` may not be official; the adapter's version path covers it, and the phase 6 live check confirms it runs.
   - `slugPattern`: `/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i`. `getModel` rejects other input before any request.
   - `verify()` → `GET /v1/account`; returns `username`.
   - `getModel(slug)` → `GET /v1/models/{owner}/{name}`. `fields` come from `fieldsFromOpenApi(latest_version.openapi_schema.components.schemas.Input, ...components.schemas)`. `ref = { isOfficial, versionId }`. A non-official model without `latest_version` fails with `not_found` and a clear sentence.
   - `prepareImage(file, name)`: rejects above `MAX_UPLOAD_BYTES`; returns a data URI for ≤ 256 KB; otherwise uploads with multipart `POST /v1/files` (field `content`, plus `filename` and `type`) and returns `urls.get`.
   - `start(model, input)`: `POST /v1/models/{owner}/{name}/predictions` when official, else `POST /v1/predictions` with `version: '<owner>/<name>:<versionId>'`. Sends `Cancel-After: 10m` and no `Prefer` header, so the id returns immediately.
   - `poll(id)` → `GET /v1/predictions/{id}`. `cancel(id)` → `POST /v1/predictions/{id}/cancel`.
   - Mapping to `ProviderRun`: `aborted` becomes `canceled`; `output` that is a uri string or an array of uri strings becomes `outputs`; anything else goes to `outputJson`; `metrics.predict_time` becomes `predictTime`. The echoed `input` is not copied, so secrets never sit in memory.
   - The adapter never follows `urls.get` or `urls.cancel` from responses; it builds paths from the id against its own `baseURL`.
   - `download(output)`: accepts only `https:` URLs whose host is `replicate.delivery` or ends with `.replicate.delivery`. The fallback is `/replicate-files/<sub or _>/<path>`, used only when the path matches the image-extension pattern. Delegates to `downloadImage`.

3. **Registry (`registry.ts`).** `PROVIDERS: Record<PlaygroundProviderId, ProviderDefinition> = { replicate: replicateProvider }`, `listProviders()`, and `providerFor(id, settings, deps?)`, which returns `null` when the provider has no token and otherwise calls `create` with the stored config (`baseURL` defaulting to `defaultBaseURL`). Adding a provider means a new adapter module and one entry here.

## Verification

- `pnpm exec vitest run src/playground/providers/replicate src/playground/registry.test.ts`
- `registry.test.ts`: `providerFor` returns `null` without a token and uses `defaultBaseURL` when none is stored.
- Tests with an injected `fetch`:
  - official vs version endpoint and the `version` string; `Cancel-After` present and `Prefer` absent; `Authorization` present;
  - `poll` mapping for every status, including `aborted`; single-uri, array, and JSON outputs;
  - `cancel` path;
  - each HTTP error code; the token never appears in a message;
  - `prepareImage` thresholds and the multipart field name `content`; over 25 MB rejected before any request;
  - `download` rejects `https://evil.example/x.png` and `http://replicate.delivery/x.png`, builds `/replicate-files/tjzk/...` for a subdomain and `/replicate-files/_/...` for the apex, and skips the fallback for a non-image path;
  - `getModel` rejects `../x` and `a/b/c` without calling `fetch`.
