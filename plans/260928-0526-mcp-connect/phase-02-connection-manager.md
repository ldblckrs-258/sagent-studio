---
phase: 2
title: "Connection manager, transport, header auth"
status: completed
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 2: Connection manager, transport, header auth

## Goal
Hold one live MCP `Client` per enabled server, expose its catalog and status, and tie its lifetime to the unlocked session.

## Files to Create / Modify
- Create: `src/mcp/fetch.ts` — fetch wrapper for proxy rewrite, static headers, and timeout.
- Create: `src/mcp/manager.ts` — `McpConnectionManager`.
- Create: `src/mcp/state.ts` — zustand store the panel and slash list subscribe to.
- Create: `src/mcp/errors.ts` — error classification.
- Modify: `src/session/session.ts` — create the manager after unlock, auto-connect enabled servers without blocking, dispose it in `dispose()`.
- Create: `src/mcp/fetch.test.ts`, `src/mcp/manager.test.ts`.

## Tasks & Steps
1. **Fetch wrapper.** `createMcpFetch(config, baseFetch)`:
   - With a proxy URL, rewrite every request to `${proxyUrl}${targetUrl}` (the cors-anywhere prefix convention). This covers the MCP endpoint and, in phase 3, OAuth discovery and token requests.
   - Merge static headers.
   - Abort after `timeoutMs` for non-streaming requests. The long-lived SSE `GET` stream is exempt.
2. **Transport selection.**
   - `streamable-http` uses `StreamableHTTPClientTransport`.
   - `sse` uses `SSEClientTransport`.
   - `auto` tries Streamable HTTP, then falls back to SSE on a 4xx other than 401 or 403, as the spec's backward-compatibility section describes.
   - Pass the custom `fetch` to both transports. The SSE header path is verified in a test, because native `EventSource` cannot send headers.
3. **Manager.**
   - `connect(id)`, `disconnect(id)`, `reconnect(id)`, `dispose()`.
   - Status per server: `idle | connecting | ready | needs-auth | error`, with `reason`, `serverInfo`, and `capabilities`.
   - After `initialize`, page through `tools/list`, `prompts/list`, `resources/list`, and `resources/templates/list` using `nextCursor`. Only call lists for the capabilities the server declares. Cap each list at 500 items and mark it truncated past that.
   - Register `listChanged` handlers for tools, prompts, and resources. Each handler refreshes that list and bumps the store version.
   - Expose `callTool(serverId, toolName, args, signal)`, `getPrompt`, and `readResource`. Each call passes the abort signal and fails fast unless the server is `ready`.
   - Declare no client capabilities: no sampling, roots, or elicitation.
   - Reconnect once on transport close. After that, stay in `error` until the user acts.
4. **Error classification.**
   - A `TypeError` from `fetch` becomes `network_or_cors`, with the message: "The browser could not reach the server. It may be down or may not allow cross-origin requests; set a proxy URL."
   - A 401, or the SDK's `UnauthorizedError`, becomes `needs-auth`.
   - A 404 on a session becomes a reinitialize.
   - Anything else becomes `error` with the server's message, truncated to 500 characters.
5. **Session wiring.**
   - The manager lives in the session, like `ragPortInstance`.
   - `dispose()` closes every transport. For Streamable HTTP, `terminateSession()` is attempted but not awaited past one second.
   - After dispose, no call runs.

## Verification
- `manager.test.ts` uses a real `McpServer` from the SDK over `InMemoryTransport` to cover connect, paginated listing, `callTool`, `listChanged` refresh, and dispose.
- `fetch.test.ts` covers proxy rewrite, header merge, timeout abort, and SSE exemption.
- A test shows `dispose()` rejects any later `callTool`.
