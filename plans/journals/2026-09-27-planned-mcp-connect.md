---
title: Planned MCP connect
date: 2026-09-27
summary: Seven-phase plan for a browser-only MCP client using the official SDK as a third ToolRegistry source.
---

# Planned MCP connect

## What happened
Scouted the static, browser-only harness: the tool registry has providers and user tools, approval gates are keyed by `ToolGateKind`, and the production CSP allows `https:` plus localhost. Research confirmed `@modelcontextprotocol/sdk@1.30.1` works with zod 4 and its client, Streamable HTTP transport, and auth modules are browser-safe. Plan written to `plans/260928-0526-mcp-connect/` (7 phases, 35h).

`ak plan create` failed with "file exists" on a UTC-prefixed directory name that could not be located, so the plan files were written by hand. `ak plan validate` passes.

## Decision
- Approach A: the official SDK client, with MCP as a third source in `ToolRegistry`.
- CORS: connect directly, with an optional user-hosted proxy URL (cors-anywhere prefix convention) and a specific error hint.
- Auth: static headers and OAuth 2.1 PKCE through a popup, with a `BroadcastChannel` callback handled in `main.tsx`. CIMD deferred.
- Scope: tools, prompts (as slash commands), and resources (as model tools and `@` attachments).
- MCP tools are gated like http tools. Server annotations never lower the gate. Resource read tools are not gated.
- Enabled servers auto-connect after unlock. Locking the vault closes every transport.

## Next steps
- Run `/ak:cook plans/260928-0526-mcp-connect`.
- End-to-end check against a local SDK reference server with CORS enabled.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
