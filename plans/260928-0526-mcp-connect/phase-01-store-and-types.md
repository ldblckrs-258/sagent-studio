---
phase: 1
title: "Dependency, types, encrypted store"
status: completed
priority: P2
effort: "3h"
dependencies: []
---

# Phase 1: Dependency, types, encrypted store

## Goal
Persist MCP server configurations and their secrets as encrypted vault records.

## Files to Create / Modify
- Modify: `package.json`, `pnpm-lock.yaml` — add `@modelcontextprotocol/sdk` pinned to `1.30.1`.
- Modify: `src/vault/db.ts` — `version(8)` adds `mcpServers: 'id, updatedAt'`; add the `McpServerRecord` table type.
- Create: `src/mcp/types.ts` — config and secret types plus validation.
- Create: `src/mcp/store.ts` — encrypted CRUD, modeled on `src/memory/store.ts`.
- Create: `src/mcp/types.test.ts`, `src/mcp/store.test.ts`.

## Data shape
```ts
type McpTransportKind = 'auto' | 'streamable-http' | 'sse'

type McpAuth =
  | { kind: 'none' }
  | { kind: 'headers'; headers: Record<string, string> }
  | { kind: 'oauth'; clientId?: string; clientSecret?: string; scopes?: string }

interface McpServerConfig {
  id: string
  name: string
  url: string
  transport: McpTransportKind
  proxyUrl?: string
  auth: McpAuth
  enabled: boolean
  disabledTools: string[]
  timeoutMs: number
}

interface McpOAuthState {
  clientInformation?: unknown
  tokens?: unknown
  codeVerifier?: string
  discoveryState?: unknown
}
```
The encrypted payload holds `{ config, oauth }`. The `oauth` part is written only by the OAuth provider in phase 3.

## Tasks & Steps
1. Add the dependency with `pnpm add @modelcontextprotocol/sdk@1.30.1`.
2. Write `validateMcpServerConfig(value)`:
   - `name`: 1–40 characters. Its slug (`[a-z0-9_]`, max 16) must be unique across servers, because tool names derive from it.
   - `url` and `proxyUrl`: absolute. `https:` is allowed anywhere, `http:` only for `localhost` and `127.0.0.1`. This mirrors the production CSP.
   - Header names must be valid HTTP tokens. `Mcp-Session-Id` and `MCP-Protocol-Version` are rejected because the transport owns them.
   - `timeoutMs`: 1,000–300,000, default 60,000.
   - At most 20 servers.
   - Forbidden keys (`__proto__`, `constructor`, `prototype`) are rejected, as in `src/tools/types.ts`.
3. Write `mcpServerStore` with `list`, `get`, `save(config)`, `saveOAuth(id, oauth)`, and `remove`. Encrypt with AAD `mcp:<id>`, write through `vaultWriteQueue`, and keep `saveOAuth` from overwriting a concurrently saved config.
4. Add the Dexie v8 block by copying the v7 stores plus `mcpServers`.

## Verification
- `pnpm vitest run src/mcp` passes.
- A test opens a v7 fixture database and reads it after the upgrade.
- A test shows a record written under one id cannot be decrypted under another id's AAD.
