# MCP browser client via @modelcontextprotocol/sdk — research report

Date: 2026-09-28. Evidence: `npm view` on the registry, tarballs of `@modelcontextprotocol/sdk@1.30.1`, `eventsource@3.0.2`, `pkce-challenge@5.0.0` extracted and read in scratchpad, and the live MCP spec.

## 1. Version, zod, import paths

Latest is `@modelcontextprotocol/sdk@1.30.1`. `package.json` lists `zod: "^3.25 || ^4.0"` as both dependency and peerDependency, and the shipped `.d.ts` uses zod-4-only syntax (`z.core.$loose`) — compatible with the project's zod 4. Subpath exports: `Client` from `@modelcontextprotocol/sdk/client/index.js`, `StreamableHTTPClientTransport` from `.../client/streamableHttp.js`, `SSEClientTransport` from `.../client/sse.js`, and `OAuthClientProvider`/`auth()`/`UnauthorizedError`/discovery+registration helpers from `.../client/auth.js`. `finishAuth(code)` is a method on the transport instance, not a standalone export.

## 2. Browser safety

Read the import graph in `dist/esm/client/*.js`: `streamableHttp.js` imports only `../shared/transport.js` (zero deps, pure `fetch`), `./auth.js`, and `eventsource-parser/stream` (browser-safe, ReadableStream-based). `auth.js` imports `pkce-challenge`, which ships a `"browser"` export using WebCrypto. `sse.js` imports `eventsource@3`, rewritten to use `globalThis.fetch` (no `http`/`node:` refs) — also browser-usable. `cross-spawn` and `node:child_process`/`node:stream` appear only in `client/stdio.js`, never pulled by the HTTP/auth path; the default `AjvJsonSchemaValidator` depends only on pure-JS `ajv`/`ajv-formats`. **Client + StreamableHTTPClientTransport + auth.js are browser-safe as-is under Vite/rolldown.**

## 3. OAuthClientProvider / SPA flow

Required members: `redirectUrl`, `clientMetadata`, `clientInformation()`/`saveClientInformation()`, `tokens()`/`saveTokens()`, `redirectToAuthorization(url)`, `saveCodeVerifier()`/`codeVerifier()`. Optional: `state()`, `addClientAuthentication`, `validateResourceURL`, `invalidateCredentials(scope)`, `prepareTokenRequest`, `saveDiscoveryState`/`discoveryState` (caches RFC 9728/8414 lookups). `auth(provider, opts)` orchestrates the flow, returning `'AUTHORIZED' | 'REDIRECT'`. SPA pattern: `redirectToAuthorization` calls `window.location.assign(url)` (or opens a popup), persist verifier/tokens in `localStorage`, then on callback call `transport.finishAuth(code)` before retrying `connect()`. `UnauthorizedError` throws from `connect()`/`send()` when re-auth is needed.

## 4. CORS / discovery / DCR

`LATEST_PROTOCOL_VERSION` is `2025-11-25` (confirmed in `types.js` and the spec). The transport spec mandates `MCP-Session-Id`/`MCP-Protocol-Version` headers but is silent on CORS. For a browser to read `Mcp-Session-Id`/`WWW-Authenticate` (not CORS-safelisted) via `fetch`, servers must send `Access-Control-Expose-Headers` for both plus `Access-Control-Allow-Headers` covering `Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID` — most reference servers don't set this. OAuth discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`) needs the same CORS setup to work cross-origin. Per the current spec, DCR is now **MAY** (legacy fallback); priority is pre-registration → Client ID Metadata Documents (HTTPS URL as `client_id`, easy for a static SPA to host) → DCR → manual entry.

## 5. Notifications / pagination / schema

List results carry `cursor`/`nextCursor`. `ClientOptions.listChanged` gives a declarative `onChanged(error, items)` per capability (tools/prompts/resources), built on `setNotificationHandler(ToolListChangedNotificationSchema, ...)`; either approach works. Tools carry `annotations: {readOnlyHint, destructiveHint, idempotentHint, openWorldHint}` and optional `outputSchema` + `structuredContent` (validated via pluggable `jsonSchemaValidator`, default Ajv). `CallToolResult.content` covers `text`, `image`, `audio`, `resource_link`, embedded `resource`.

## 6. @ai-sdk/mcp

Exists, latest `2.0.60`, works with `ai` v7. `createMCPClient({ transport, ... })` wraps a caller-supplied `@modelcontextprotocol/sdk` transport and converts MCP tools into `ai` `tool()` objects for `generateText`/`streamText`. It doesn't replace the SDK's transport/auth layer — only useful if you want MCP tools auto-wired into `ai` v7 tool-calling; otherwise the raw SDK `Client` is lighter.

## Sources
- `npm view @modelcontextprotocol/sdk` + tarball inspection of `dist/esm/{client,shared,validation}` at v1.30.1
- `npm view eventsource@3.0.2` / `pkce-challenge@5.0.0 exports` + tarball inspection
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools , https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client
- `npm view @ai-sdk/mcp`

## Unresolved questions
- No target MCP server named yet — actual CORS header support and CIMD/DCR availability must be checked against whatever server sagent-studio connects to first.
- Native browser `EventSource` doesn't support custom `Authorization` headers; whether `SSEClientTransport`'s `eventsource` polyfill is actually exercised at runtime (vs. native EventSource) wasn't verified live — test before relying on SSE as an authenticated fallback transport.

Status: DONE
Summary: All 6 items answered with source-backed evidence — SDK v1.30.1 (zod4-compatible), exact subpath imports, confirmed browser-safety of Client+StreamableHTTPClientTransport+auth.js via import-graph inspection, full OAuthClientProvider/SPA finishAuth flow, current spec (2025-11-25) CORS/discovery/DCR nuances (DCR now MAY, CIMD preferred), and listChanged/pagination/annotations/content-type/@ai-sdk-mcp comparison.
Concerns: CORS and OAuth-discovery behavior is server-dependent and unverifiable without a concrete target server; SSE transport's header-auth viability needs a runtime check, not just static analysis.
