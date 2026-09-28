---
phase: 5
title: "Prompts and resources"
status: completed
priority: P2
effort: "7h"
dependencies: [2, 4]
---

# Phase 5: Prompts and resources

## Goal
Make MCP prompts runnable as slash commands and MCP resources readable by the model and attachable by the user.

## Files to Create / Modify
- Modify: `src/chat/slash.ts` — add an `mcp-prompt` entry kind.
- Create: `src/mcp/prompt-invoke.ts` — argument parsing and dispatch.
- Create: `src/tools/builtin/mcp-resources.ts` — `list_mcp_resources` and `read_mcp_resource` provider.
- Modify: `src/tools/approval.ts` — add both tools to `READ_ONLY_TOOLS`.
- Modify: `src/session/session.ts` — register the provider.
- Modify: `src/chat/attachments.ts`, `src/ui/mention-index.ts`, `src/ui/mention-suggestions.tsx` — MCP resource attachments.
- Tests next to each file. Add a transcript view spec for the two built-in tools, because `tool-view.test.tsx` requires one for every built-in.

## Prompts
1. Each enabled server's prompts become slash entries with id `<serverSlug>.<promptName>`. This fits the existing `COMMAND_SHAPE` (`[A-Za-z0-9_@.-]`). Built-ins and skills win a collision, and the prompt is then listed with a `mcp.` prefix.
2. Argument parsing:
   - With exactly one declared argument, the whole argument string is its value.
   - Otherwise, parse `key=value` pairs, where values may be quoted.
   - A missing required argument fails with a message that lists the arguments and nothing is sent. This follows the `UnknownSlashCommandError` pattern.
3. `getPrompt` returns messages. Text parts become the user turn's text, in order, each prefixed with its role when the role is `assistant`. Embedded text resources are appended as fenced blocks. Other content types are listed by type and mime type. The turn is sent through the same path `invokeSkill` uses.

## Resources for the model
- `list_mcp_resources({ server? })` returns up to 200 resources and templates per server, with `server`, `uri`, `name`, `mimeType`, and `size`.
- `read_mcp_resource({ server, uri })` returns text contents capped at 100,000 characters. For blob contents it returns `{ mimeType, bytes }` without base64. Template URIs are accepted as filled in by the model.
- Both tools are available only when at least one ready server declares `resources`.
- Both are non-gated read tools (user decision, 2026-09-28). They only send a URI to a server the user configured.

## Resources for the user
- The `@` suggestions add a group "MCP resources" when any are listed, matched by name and URI.
- A new attachment kind `mcp-resource` carries `{ serverId, uri, name }`. At send time the contents are read and inlined under the existing `INLINE_BUDGET_BYTES`. An unreachable server gives the `missing` mode with a reason, as a missing workspace file does now.
- Persistence and sanitize accept the new kind. Old threads are unchanged.

## Verification
- `slash.test.ts` covers prompt entries, collisions, argument parsing, and missing arguments.
- `mcp-resources.test.ts` covers list and read against an in-process server, caps, and blob descriptors.
- `attachments.test.ts` covers inlining an `mcp-resource`, the budget, and the unreachable server case.
- `tool-view.test.tsx` passes.
