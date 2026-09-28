---
phase: 6
title: "MCP rail panel"
status: pending
priority: P2
effort: "6h"
dependencies: [2, 3, 4]
---

# Phase 6: MCP rail panel

## Goal
Let the user add, connect, sign in to, inspect, and remove MCP servers.

## Files to Create / Modify
- Create: `src/ui/panels/mcp.tsx`.
- Modify: `src/ui/shell.tsx` — add rail id `mcp` after `tools`.
- Modify: `src/settings/DataEgressNotice.tsx` — name MCP servers and proxies as egress targets.
- Create: `src/ui/panels/mcp.test.tsx`.

## Layout
- **Server list:** name, status dot, status text, tool/prompt/resource counts. Actions: Connect or Disconnect, Sign in (shown when `needs-auth`), Edit, and Remove (with confirmation).
- **Add or edit form:**
  - Name, URL, and transport (Auto, Streamable HTTP, SSE).
  - Proxy URL. When set, a warning says the proxy can read all traffic and tokens.
  - Auth: None, Headers (key and value rows, values in `SecretField`), or OAuth (optional client ID and secret, and scopes).
  - Timeout.
  - Validation messages come from `validateMcpServerConfig`.
- **Server detail:**
  - The error reason, with the proxy hint for `network_or_cors`.
  - Skipped tool names with reasons.
  - A tool list with an enable toggle per tool, which writes `disabledTools`.
  - Prompt and resource lists, read-only.
  - Sign out for OAuth.
- Follow the patterns and primitives of `src/ui/panels/tools.tsx` and `src/settings/ProvidersPanel.tsx`. No new design tokens.

## Verification
- `mcp.test.tsx` covers:
  - adding a server with a validation error, then a valid one;
  - status rendering for each state;
  - the proxy warning;
  - the tool toggle persisting;
  - remove confirming before deleting.
- Manual visual check in the running dev server, which is already running per the user rule.
