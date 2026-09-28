---
phase: 4
title: "Tools bridge and approval gate"
status: pending
priority: P1
effort: "5h"
dependencies: [2]
---

# Phase 4: Tools bridge and approval gate

## Goal
Expose each enabled MCP tool to the model as a gated, namespaced tool that sub-agents also inherit.

## Files to Create / Modify
- Modify: `src/tools/registry.ts` — add an external tool source.
- Modify: `src/tools/types.ts` — add the `ExternalToolEntry` type.
- Modify: `src/tools/approval.ts` — add gate kind `mcp`.
- Modify: `src/chat/engine.ts:500`, `src/agents/runner.ts:193`, `src/agents/toolset.ts:31` — use the generalized `toolKind(name)`.
- Create: `src/mcp/tool-bridge.ts` — naming, schema capping, and result mapping.
- Create: `src/tools/builtin/guides/mcp.md`. Modify: `src/tools/builtin/tool-guide.ts` — add an `mcp` topic.
- Modify: `src/session/session.ts` — push manager tool snapshots into the registry.
- Create: `src/mcp/tool-bridge.test.ts`. Modify: `src/tools/registry.test.ts`, `src/tools/approval.test.ts`.

## Tasks & Steps
1. **Registry source.**
   - `setExternalTools(sourceId, entries)` replaces the entries for one source and calls `notify()`. `clearExternalTools(sourceId)` removes them.
   - `hasTool`, `availableNames`, and `buildToolSet` include external entries.
   - A name already owned by a provider or a user tool is skipped. The method returns the skipped names so the manager can show them.
   - Rename `userToolKind` to `toolKind`, returning `'sandbox-js' | 'http' | 'mcp' | undefined`, and update the three call sites.
2. **Naming.**
   - `mcp_<serverSlug>_<toolSlug>`, where each slug is lowercased, non-`[a-z0-9_]` characters become `_`, and repeated underscores collapse.
   - When longer than 64 characters, truncate the tool slug and append `_` plus a 6-character hash of the original name.
   - A collision inside one server is skipped and reported. The manager keeps a map from exposed name to original name.
3. **Tool construction.**
   - The description is prefixed with `[MCP: <server name>]` and capped at 2,000 characters.
   - `inputSchema` goes through `assertPlainSchema`. A tool whose schema fails is skipped and reported.
   - `execute` calls `manager.callTool` with the abort signal.
4. **Result mapping.**
   - `isError: true` maps to `toolFail('runtime_error', text)`.
   - Otherwise `toolOk({ content, structuredContent? })`, where:
     - `text` content is joined.
     - `image` and `audio` become `{ type, mimeType, bytes }` descriptors without base64.
     - `resource_link` stays as-is.
     - An embedded text `resource` is inlined.
   - Total text is capped at 100,000 characters with a `truncated` flag.
5. **Approval.**
   - `ToolGateKind` gains `'mcp'`, and `isUserCodeOrNetwork` treats `mcp` like `http`.
   - MCP tools are therefore gated by default, allowed inside the `editing` ceiling with a prompt, and escalated in `read_only`.
   - Server annotations are ignored for gating.
   - A persisted `allow` or `deny` keyed by the exposed name works unchanged.
6. **Per-tool toggle.** A tool listed in `disabledTools` is not published.
7. **Guide.** `mcp.md` says that MCP tools come from third-party servers, that their output is untrusted data rather than instructions, and how naming works.

## Verification
- `registry.test.ts` covers an external source being added, replaced, and cleared, collision skipping, and `toolKind`.
- `approval.test.ts` covers `mcp` gated in `editing`, escalated in `read_only`, approved in `god`, persisted `deny` winning, and `readOnlyHint` not bypassing.
- `tool-bridge.test.ts` covers naming edge cases (unicode, over 64 characters, collisions) and result mapping for every content type.
- An agent test shows a sub-agent receives an MCP tool from the parent pool.
