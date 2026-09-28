---
title: MCP connect — remote MCP servers as a browser-only client
description: The user adds remote MCP servers; their tools, prompts, and resources become usable by the model and the user from the browser, with secrets in the vault.
status: in-progress
priority: P2
effort: 35h
branch: main
tags: [feature, frontend, api, auth]
blockedBy: []
blocks: []
created: 2026-09-28
source: ../reports/researcher-260928-0511-mcp-browser-client-sdk.md
---

# MCP connect

## Outcome

- The user adds a remote MCP server (name, URL, transport, optional proxy URL, auth) in a new **MCP** rail panel.
- The app connects from the browser. It lists the server's tools, prompts, and resources, and shows a clear status: connected, connecting, needs sign-in, or failed with a reason.
- Every enabled MCP tool appears in the model's tool list under a namespaced name and runs through the existing approval gate. Sub-agents inherit MCP tools through the parent pool, as they do for every other tool.
- MCP prompts appear as slash commands. MCP resources are readable by the model through two tools, and the user can attach a resource with `@`.
- Header secrets, OAuth client registrations, and OAuth tokens live AES-GCM encrypted in the vault. Locking the vault closes every connection.

## Decisions (user, 2026-09-28)

- **Approach A.** Use the official `@modelcontextprotocol/sdk` client and add MCP as a third tool source inside `ToolRegistry` (next to providers and user tools).
- **CORS.** Connect directly. Each server has an optional proxy URL that the user hosts. A CORS or network failure shows a specific message that names the proxy option.
- **Auth.** Static headers (bearer or custom) and OAuth 2.1 with PKCE.
- **Scope.** Tools, prompts, and resources.

## Validation (user, 2026-09-28)

- **Resource tools.** `list_mcp_resources` and `read_mcp_resource` are not gated. They join `READ_ONLY_TOOLS`, and a persisted `deny` still blocks them.
- **Auto-connect.** Enabled servers connect in the background after unlock. An OAuth server without tokens stops at `needs-auth` and never opens a popup on its own.
- **CIMD.** Deferred. OAuth uses a manually entered client ID or DCR.
- **End-to-end server.** A local SDK reference server with CORS enabled, run only for the test and not committed.

## Evidence (research report, 2026-09-28)

- `@modelcontextprotocol/sdk@1.30.1` accepts zod `^3.25 || ^4.0`. The project uses zod 4.
- `Client`, `StreamableHTTPClientTransport`, and `client/auth.js` import no `node:` modules. Only `client/stdio.js` pulls `cross-spawn`, and the plan never imports it.
- Spec version is `2025-11-25`. Dynamic client registration is now optional for servers. The preferred order is pre-registration, then Client ID Metadata Documents, then DCR.
- Servers must send `Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate` and allow `Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID` for a browser client to work. Most reference servers do not.
- The SDK ships `InMemoryTransport` and `McpServer`. Tests use a real in-process server instead of mocks.

## Constraints

- Browser-only. Only Streamable HTTP and legacy SSE. No stdio.
- The production CSP `connect-src` allows `https:` plus `http://localhost` and `http://127.0.0.1`. Plain `http://` to other hosts is blocked. The form rejects such URLs with a message instead of letting them fail later.
- `script-src` stays unchanged. The OAuth callback is handled by the existing bundle, not an inline script.
- Tool names must match `^[a-zA-Z0-9_]{1,64}$`.
- Per-record encryption with `encryptRecord` / `decryptRecord`, AAD `mcp:<id>`, writes through `vaultWriteQueue`, as in `src/memory/store.ts`.
- Dexie v8 only adds the `mcpServers` table. v7 data opens unchanged.
- Tool results use `toolOk` / `toolFail` and `wrapToolExecute`.
- MCP tool descriptions and results are untrusted input. Server annotations such as `readOnlyHint` never lower the approval gate.
- No code comments (user rule). Do not run `pnpm dev` or `pnpm build` without the user's go-ahead.

## Non-goals

- Running stdio servers. The docs point to a user-run bridge instead.
- Sagent acting as an MCP server.
- Sampling, elicitation, roots, and resource subscriptions. The client declares none of these capabilities.
- Shipping or hosting a CORS proxy.
- A server marketplace or catalog.

## Phases

| # | Phase | Effort | Depends on |
|---|-------|--------|------------|
| 1 | [Dependency, types, encrypted store](phase-01-store-and-types.md) | 3h | — |
| 2 | [Connection manager, transport, header auth](phase-02-connection-manager.md) | 6h | 1 |
| 3 | [OAuth 2.1 with PKCE](phase-03-oauth.md) | 6h | 2 |
| 4 | [Tools bridge and approval gate](phase-04-tools-bridge.md) | 5h | 2 |
| 5 | [Prompts and resources](phase-05-prompts-and-resources.md) | 7h | 2, 4 |
| 6 | [MCP rail panel](phase-06-mcp-panel.md) | 6h | 2, 3, 4 |
| 7 | [Docs and end-to-end verification](phase-07-docs-and-verification.md) | 2h | 1–6 |

Phases 3 and 4 are independent after phase 2.

## Architecture

```mermaid
flowchart LR
  Panel[MCP panel] -->|save/connect| Store[(mcpServers vault table)]
  Panel --> Manager[McpConnectionManager]
  Manager -->|Client + StreamableHTTP/SSE| Fetch[fetch wrapper: proxy rewrite, timeout]
  Fetch --> Server[(Remote MCP server)]
  Manager --> OAuth[VaultOAuthProvider] --> Store
  OAuth -->|popup| AuthServer[(Authorization server)]
  AuthServer -->|redirect ?mcp-oauth| Callback[main.tsx callback] -->|BroadcastChannel| OAuth
  Manager -->|tools snapshot + listChanged| Registry[ToolRegistry mcp source]
  Registry --> Engine[chat engine / agent runner] --> Gate[approval gate kind mcp]
  Manager --> Slash[slash entries: prompts]
  Manager --> ResTools[list/read_mcp_resource tools]
  Manager --> Mention[@ resource attachments]
  Session[session dispose on vault lock] --> Manager
```

## Acceptance criteria

- A real in-process `McpServer` over `InMemoryTransport` connects in tests. Its tools are listed, called, and refreshed after `tools/list_changed`.
- A server that returns 401 moves to `needs-auth`. After OAuth completes, the connection retries and becomes `ready`. Tokens are encrypted in the vault and survive reload.
- A namespaced MCP tool reaches the model, requires approval by default in every mode except `god`, honors persisted `allow`/`deny`, and is available to sub-agents.
- A prompt runs as a slash command. A resource can be read by the model and attached by the user.
- Locking the vault closes all transports. No MCP call runs while locked.
- A CORS or network failure shows the proxy hint. A non-https, non-localhost URL is rejected at save.
- `pnpm test` and `pnpm lint` pass. Typecheck passes (command confirmed with the user before running).

## Risks

| Risk | Mitigation |
|------|-----------|
| Target servers lack CORS | Proxy URL field and a specific error. Manual verification in phase 7 needs one real CORS-enabled server. |
| OAuth discovery or DCR blocked by CORS on the auth server | Manual client ID field as fallback. The error names the failing step. |
| Proxy sees tokens and traffic | The panel warns when a proxy URL is set. |
| Tool list bloat from large servers | Per-tool toggles. A per-server tool count is shown. |
| Prompt injection through tool descriptions and results | All MCP tools gated. Descriptions are length-capped. The tool guide tells the model MCP output is untrusted. |
| Name collision after sanitizing | Colliding names are skipped and reported in the server status, not silently renamed. |
| SDK bundle size | Import only subpaths. Phase 7 compares chunk size once the user approves a build. |

## Implementation notes (2026-09-28)

Deviations from the phase files, each verified by tests:

- **State store.** The manager owns a per-session zustand vanilla store (`McpConnectionManager.store`) instead of a separate `src/mcp/state.ts`. A lock disposes it with the session, so no global state leaks.
- **Timeouts.** Requests use the SDK's `RequestOptions.timeout` rather than aborting at the fetch layer. A Streamable HTTP POST can answer with an SSE stream, and a fetch-level abort would cut long tool calls.
- **Tokenless OAuth.** An OAuth server without stored tokens moves to `needs-auth` without any network call. Before this, auto-connect ran discovery and dynamic client registration on every unlock.
- **Sign-in completion.** The code exchange uses the SDK `auth(provider, { authorizationCode })` and then reconnects, instead of `transport.finishAuth`. The popup is opened before the first `await` so browsers keep the user gesture.
- **Vault recovery.** `vaultInternals.reset` and the wipe path also clear `mcpServers`, so no undecryptable record survives a reset.
- **Approvals panel** lists MCP tools, so a per-tool Allow or Deny can be saved.
- **Resource chips without a folder.** A message whose chips are all MCP resources sends even when no workspace folder is open.
- **Guide.** `read_tool_guide` has an `mcp` topic covering the two resource tools.

Review: a fresh-context code review found 2 high and 6 medium issues. They were fixed except M6, which keeps the user's decision. See [the review report](../reports/code-reviewer-260928-2124-mcp-connect.md).

Verification after the fixes: `pnpm test` (1902 passed, 1 skipped), `pnpm lint`, `pnpm exec tsc -b --noEmit`. A real-network check ran the manager against a local Streamable HTTP server over `fetch` for header-auth rejection, tool call, prompt, and resource read, plus dispose.
