---
phase: 7
title: "Docs and end-to-end verification"
status: pending
priority: P2
effort: "2h"
dependencies: [1, 2, 3, 4, 5, 6]
---

# Phase 7: Docs and end-to-end verification

## Goal
Document MCP connect and prove it against a real server.

## Files to Create / Modify
- Modify: `README.md` — add an "Connecting MCP servers" section and add MCP to the egress list in the security section.
- Modify: `vite.config.ts` comment block only if the CSP reasoning changes. The plan expects no CSP change.

## Tasks & Steps
1. README content:
   - Supported transports.
   - The CORS requirement and the exact headers a server must send.
   - The proxy URL convention (`${proxyUrl}${targetUrl}`) and its trust implication.
   - OAuth sign-in and the redirect URL to pre-register.
   - How gating works.
   - Stdio servers need a user-run bridge.
2. Run `pnpm test` and `pnpm lint`.
3. Ask the user before running the typecheck (`pnpm exec tsc -b`) and before any `pnpm build`.
4. Manual end-to-end check in the running dev server. The target is a local SDK reference server (`McpServer` + `StreamableHTTPServerTransport`) with CORS enabled, placed in the scratchpad and not committed. Give it one tool, one prompt, and one resource. Stop the server when the check ends. Check that you can:
   - connect;
   - call a tool with approval;
   - run a prompt;
   - attach a resource;
   - lock the vault and confirm the connection closes in the network panel.
