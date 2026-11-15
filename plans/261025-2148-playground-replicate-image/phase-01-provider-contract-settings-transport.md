---
phase: 1
title: Provider contract, settings, and transport
status: completed
priority: P2
effort: 4h
dependencies: []
---

# Phase 1 — Provider contract, settings, and transport

## Goal

A provider-neutral contract, form field type, error type, and streaming download helper exist. Provider tokens are stored in vault settings. The `/replicate` and hardened `/replicate-files` paths work in dev, preview, and production config.

## Files

- Create:
  - `src/playground/types.ts`
  - `src/playground/provider.ts`
  - `src/playground/errors.ts`
  - `src/playground/download.ts`
  - `vercel.json`
- Modify:
  - `vite.config.ts`: shared proxy map with the two Replicate entries.
  - `src/vault/settings.ts`: `PlaygroundProviderSettings`, `Settings.playgroundProviders?`, `validatePlaygroundProviders`, `migrate`.
  - `src/vault/store.ts`: `setPlaygroundProvider(id, config | null)`.
- Tests:
  - `src/playground/download.test.ts`
  - `src/playground/errors.test.ts`
  - `src/vault/settings.test.ts` (extend)
  - `src/vault/store.test.ts` (extend)

## Steps

0. **Live gate (before code, with the user).** In the user's browser, open one `replicate.delivery` image (any model cover image) and run a `fetch` with `mode: 'cors'` from the dev app's console. Record whether it loads and whether `access-control-allow-origin` is present. A reset connection like this machine's means downloads depend on the proxy fallback; tell the user before continuing.
1. **Types (`types.ts`).**
   - `PlaygroundProviderId = 'replicate'`.
   - `RunStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'interrupted' | 'expired'` and `isTerminal(status)` (all but the first two).
   - `PlaygroundModel = { providerId, slug, label, description?, fields: FormField[], editsImages: boolean, ref: unknown }`, where `ref` is opaque provider data such as a version id.
   - `ProviderRun = { providerRunId: string; status: RunStatus; outputs?: ProviderOutput[]; outputJson?: unknown; error?: string; predictTime?: number }`.
   - `ProviderOutput = { url: string; mime?: string }`.
   - `FormField = { name, label, description?, required, default?, nullable, secret: boolean } & ({ kind: 'text'; multiline: boolean } | { kind: 'select'; options: readonly (string | number)[] } | { kind: 'integer' | 'number'; min?; max?; step } | { kind: 'boolean' } | { kind: 'image' } | { kind: 'images' } | { kind: 'json' })`. Phase 2 adds the functions that work on it.
2. **Contract (`provider.ts`).**
   ```ts
   interface PlaygroundProvider {
     readonly id: PlaygroundProviderId
     verify(signal?: AbortSignal): Promise<{ account: string }>
     getModel(slug: string, signal?: AbortSignal): Promise<PlaygroundModel>
     prepareImage(file: Blob, name: string, signal?: AbortSignal): Promise<string>
     start(model: PlaygroundModel, input: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderRun>
     poll(providerRunId: string, signal?: AbortSignal): Promise<ProviderRun>
     cancel(providerRunId: string): Promise<void>
     download(output: ProviderOutput, signal?: AbortSignal): Promise<{ blob: Blob; mime: string }>
   }
   interface ProviderDefinition {
     id: PlaygroundProviderId
     label: string
     tokenLabel: string
     tokenUrl: string
     defaultBaseURL: string
     quickModels: readonly string[]
     slugPattern: RegExp
     retentionMs: number
     create(config: PlaygroundProviderSettings, deps?: { fetch?: typeof fetch }): PlaygroundProvider
   }
   ```
3. **Registry contract.** The registry itself is created in phase 3 with its first entry. Phase 1 only defines `ProviderDefinition`, so phase 4 can take a provider as an argument and test with a fake.
4. **Errors (`errors.ts`).**
   - `PlaygroundError { code, status?, message }`, codes: `no_token`, `unauthorized`, `payment_required`, `not_found`, `invalid_input`, `rate_limited`, `too_large`, `network`, `prediction_failed`, `canceled`, `unsupported_output`, `storage_full`, `http`.
   - `fromHttp(status, body, fallbacks)` reads problem+json `detail`, then `title`, then a fixed sentence per code.
   - `redactToken(message, token)` replaces the exact token and runs `redactSecrets` (`src/tools/redact.ts:13`). Every adapter error passes through it.
5. **Download (`download.ts`).** `downloadImage(url, { fetch, signal, maxBytes = REMOTE_BINARY_CAP, fallbackUrl? })`:
   - fetch with `credentials: 'omit'` and the signal;
   - on a raw `TypeError` (before any wrapping) and when `fallbackUrl` is set, retry once with the fallback;
   - reject when `content-length` exceeds `maxBytes`, then read `response.body` with a reader, count bytes, and cancel the reader past the cap (`too_large`);
   - require a `content-type` starting with `image/` (`unsupported_output` otherwise);
   - return `{ blob, mime }`.
   Export `REMOTE_BINARY_CAP` from `src/ui/file-view/load.ts` if it is not already exported, and reuse it.
6. **Settings.**
   - `PlaygroundProviderSettings = { apiKey: string; baseURL?: string }`. `Settings.playgroundProviders?: Partial<Record<PlaygroundProviderId, PlaygroundProviderSettings>>`, optional and not in `defaultSettings()`.
   - `validatePlaygroundProviders(value)` keeps only known provider ids, drops entries with a blank `apiKey`, and drops a `baseURL` unless `new URL(value, 'https://app.invalid')` either keeps the `app.invalid` origin (a same-origin path) or has protocol `https:`. A value starting with `//` or `/\` is always rejected. Trailing `/` is stripped.
   - `migrate` destructures `playgroundProviders` out of `rest`, validates it, and re-adds it only when non-empty, like `terminal` (`src/vault/settings.ts:517`, `:532`, `:540`).
   - `setPlaygroundProvider(id, next | null)` follows `setTerminal` (`src/vault/store.ts:339`). It validates `next` with the same function and throws `VaultSettingsError` for an invalid `baseURL`, so the UI can show it. `null` deletes the provider entry, and the whole block when it becomes empty.
7. **Proxies.**
   - In `vite.config.ts`, rename `typesafeProxy` to `devProxy` and add regex keys. Order does not matter with anchored keys:
     - `"^/replicate/v1/"` → `https://api.replicate.com`, rewrite `^/replicate` → ``, `changeOrigin: true`.
     - `"^/replicate-files/[a-z0-9-]{1,32}/.+\\.(png|jpe?g|webp|gif|avif)$"` → `https://replicate.delivery` with a `router` that maps the second segment to `https://<sub>.replicate.delivery` (`_` means the apex), rewrite to the remaining path, `changeOrigin: true`. A `configure` hook sets the hardened headers on `proxyRes`.
   - Create `vercel.json`:
     ```json
     {
       "$schema": "https://openapi.vercel.sh/vercel.json",
       "rewrites": [
         { "source": "/replicate/v1/:path*", "destination": "https://api.replicate.com/v1/:path*" },
         { "source": "/replicate-files/_/:path((?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(?:png|jpe?g|webp|gif|avif))", "destination": "https://replicate.delivery/:path" },
         { "source": "/replicate-files/:sub([a-z0-9-]{1,32})/:path((?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(?:png|jpe?g|webp|gif|avif))", "destination": "https://:sub.replicate.delivery/:path" }
       ],
       "headers": [
         {
           "source": "/replicate/v1/:path*",
           "headers": [
             { "key": "x-vercel-enable-rewrite-caching", "value": "0" },
             { "key": "Cache-Control", "value": "no-store" }
           ]
         },
         {
           "source": "/replicate-files/:path*",
           "headers": [
             { "key": "x-vercel-enable-rewrite-caching", "value": "0" },
             { "key": "Cache-Control", "value": "no-store" },
             { "key": "Content-Security-Policy", "value": "sandbox; default-src 'none'" },
             { "key": "Content-Disposition", "value": "attachment" },
             { "key": "X-Content-Type-Options", "value": "nosniff" },
             { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" }
           ]
         }
       ]
     }
     ```
   - Export the dev proxy map from a small module (`vite-proxy.ts` at the repo root, imported by `vite.config.ts`) so a unit test can check which key matches which path.

## Verification

- `pnpm exec vitest run src/playground src/vault/settings.test.ts src/vault/store.test.ts`
- `download.test.ts`: retry on `TypeError` only; no retry on HTTP 404; abort through the signal stops the read; `content-length` over the cap rejects before reading; a streamed body over the cap rejects; a non-image `content-type` rejects.
- `errors.test.ts`: problem+json `detail` and `title` fallbacks, and the token never appears in a message.
- Settings: valid entries kept; blank token dropped; unknown provider id dropped; `//evil.example`, `/\evil.example`, and `http://evil.example` rejected; `/replicate` and `https://proxy.example` accepted; the setter throws on an invalid `baseURL` and deletes the block when the last provider is cleared.
- A proxy-map test (in `src/playground/download.test.ts` or a new `vite-proxy.test.ts`): `/replicate/v1/predictions` matches only the API key; `/replicate-files/tjzk/a/out-0.webp` matches only the files key; `/replicate-files/tjzk/a/x.html` and `/replicatefoo` match nothing.
