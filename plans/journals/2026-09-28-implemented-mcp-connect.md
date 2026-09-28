---
title: Implemented MCP connect
date: 2026-09-28
summary: "Browser-only MCP client: tools, prompts, resources, OAuth; review found a StrictMode kill and a token-to-new-host leak, both fixed."
---

# Implemented MCP connect

## What happened
Implemented plans/260928-0526-mcp-connect phases 1-6 and the docs part of 7. Tests went from 1779 to 1902 passing. Lint and `tsc -b` are clean. A real-network check drove the manager against a local Streamable HTTP server.

## Surprises
- A tokenless OAuth auto-connect ran discovery and dynamic client registration on every unlock. It now goes straight to `needs-auth` without network.
- The fresh-context review found that StrictMode's effect cleanup disposed the session-owned manager for good. Every direct manager test passed; only the UI path showed it. The fix is `startMcp()` plus a revivable manager with an epoch guard.
- Editing an OAuth server's URL sent the old bearer token to the new host. OAuth state is now bound to URL, proxy, and client.

## Decision
MCP tool approvals reset to `ask` when a server is removed, repointed, or renamed. Resource reads stay ungated per the user's decision; the review flagged the template-URI trade-off.

## Next steps
- Manual browser check with an unlocked vault: panel, sign-in popup, approval prompt, `@` resource, lock closes connections.
- Decide whether template-expanded resource reads should ask for approval.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
