---
phase: 3
title: "OAuth 2.1 with PKCE"
status: pending
priority: P2
effort: "6h"
dependencies: [2]
---

# Phase 3: OAuth 2.1 with PKCE

## Goal
Sign in to OAuth-protected MCP servers from a popup and keep their tokens encrypted in the vault.

## Files to Create / Modify
- Create: `src/mcp/oauth-provider.ts` — `VaultOAuthProvider implements OAuthClientProvider`.
- Create: `src/mcp/oauth-callback.ts` — callback detection plus a `BroadcastChannel` handoff.
- Modify: `src/main.tsx` — before rendering the app, handle a callback URL and close the popup.
- Modify: `src/mcp/manager.ts` — `signIn(id)` flow, `needs-auth` transitions, and token refresh through the SDK.
- Create: `src/mcp/oauth-provider.test.ts`, `src/mcp/oauth-callback.test.ts`.

## Flow
1. The user clicks **Sign in**. This is a user gesture, so the popup is allowed. The manager opens an empty popup first, then runs the SDK `auth(provider, { serverUrl, fetchFn })`.
2. `redirectToAuthorization(url)` navigates the already-open popup to `url`. The redirect URL is `${location.origin}/?mcp-oauth=callback`.
3. The authorization server redirects to the callback. `main.tsx` sees `mcp-oauth=callback` and posts `{ state, code, error }` on the `BroadcastChannel` named `sagent-mcp-oauth`. It then closes the window without mounting the app or touching the vault.
4. The opener checks that `state` matches the one stored in memory for this attempt, then calls `transport.finishAuth(code)` and reconnects.
5. A popup closed without a result, or a 5-minute timeout, ends in `needs-auth` with a reason.

## Provider details
- `clientMetadata`: `client_name: "sagent-studio"`, `redirect_uris: [redirectUrl]`, `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, `token_endpoint_auth_method: "none"`.
- `clientInformation()` returns the manual `clientId` / `clientSecret` from the config when set. Otherwise it returns the stored DCR registration.
- `tokens`, `saveTokens`, `saveClientInformation`, `saveCodeVerifier`, `codeVerifier`, `saveDiscoveryState`, and `discoveryState` read and write the encrypted `oauth` part through `mcpServerStore.saveOAuth`.
- `state()` returns a random 32-byte value, kept in memory only.
- `invalidateCredentials(scope)` clears the matching fields. A **Sign out** button uses `'all'`.
- All discovery, registration, and token calls use the phase 2 fetch wrapper, so a proxy URL applies to them too.
- Client ID Metadata Documents are deferred (user decision, 2026-09-28). They need a public HTTPS metadata URL, which a localhost setup cannot provide.

## Verification
- A provider test round-trips tokens, verifier, and client info through the encrypted store.
- A callback test covers the parsed `code`/`state`/`error`, a mismatched `state` being rejected, and the callback path never mounting the app.
- A manager test runs a 401 from an in-process server, which moves to `needs-auth`. Stubbed `finishAuth` then moves it to `ready` on reconnect.
