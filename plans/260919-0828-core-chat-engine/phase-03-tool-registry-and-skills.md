---
phase: 3
title: "Tool Registry and Skills"
status: done
priority: P1
effort: "10h"
dependencies: [2]
---

# Phase 3: Tool Registry and Skills

## Goal

Provide the tool registry that turns builtin providers and user `sandbox-js`
definitions into an AI SDK `ToolSet`, the SKILL.md model with a parser, and
encrypted skill/tool storage with an explicit enable model that prevents a skill
from widening the tool set.

## Context

- `ai@7` exports `tool`, `jsonSchema`, `ToolSet`; tools use `inputSchema`
  (`ai/dist/index.d.ts:7`, researcher-02 Q2). `jsonSchema` accepts raw JSON Schema,
  so no `zod` dependency.
- `CodeRunner` is frozen in Phase 1 (`src/sandbox/types.ts`).
- Record storage and the shared write queue come from Phase 2.
- Repo skill convention: `.agents/skills/**/SKILL.md`.
- Dexie is at version 2 after Phase 2.

## Requirements

Functional:

- `ToolDefinition` union with two arms: `sandbox-js` (name, description, JSON
  Schema, source) and `http` (name, description, JSON Schema, request template),
  each with an `enabled` flag.
- `http` tools are hardened: a required per-tool host allow-list; templates may not
  interpolate into the URL authority (scheme/host/port) or header names; the
  resolved URL origin is checked against the allow-list after substitution; the
  response body is size-capped; non-2xx maps to a typed error.
- `sandbox-js` execution requires an injected `CodeRunner`; absence throws
  `ToolRuntimeUnavailableError`.
- `ToolProvider = { names; create(name, ports): Tool }` contributed by later
  phases (workspace in Phase 4, code in Phase 5).
- `ToolRegistry.buildToolSet(requestedNames)` returns a `ToolSet` built from
  builtin providers and enabled user definitions, using `jsonSchema` and `tool`.
- `SkillManifest`: id, name, description, markdown instructions, allowedTools,
  source, optional path.
- `parseSkillMarkdown(md, fallbackName)` reads YAML frontmatter and body,
  accepting `allowed-tools` and `allowedTools`, throwing `SkillParseError` on
  malformed input.
- `SkillRegistry`: register, get, list, `resolve(refs)`, `instructionsFor(refs)`,
  `toolNamesFor(refs)`, `importSkill`, `updateSkill`, `removeSkill`, `setEnabled`.
- Skills and tools persist encrypted and survive reload.
- Tool selection is a two-level rule: the enabled pool is builtin providers that
  are available plus enabled user tools; a skill's `allowedTools` only narrows that
  pool, never widens it. An empty `allowedTools` means "use the whole pool".

Non-functional:

- Names validated against `^[a-zA-Z0-9_]{1,64}$`.
- Schemas validated as plain JSON objects; prototype-polluting keys rejected.
- Build ordering is deterministic so tool fingerprints are stable.

## Architecture

```
src/tools/types.ts        ToolDefinition, ToolProvider, ToolRuntimePorts,
                          JsonSchemaObject, validateToolName, assertPlainSchema
src/tools/http.ts         executeHttpTool: allow-list + origin check + body cap
src/tools/registry.ts     ToolRegistry { registerProvider, registerUserTool,
                          setEnabled, list, buildToolSet }
src/tools/store.ts        Dexie v3 `tools`; encrypted CRUD
src/skills/schema.ts      SkillManifest, SkillRef resolution
src/skills/parser.ts      parseSkillMarkdown
src/skills/registry.ts    SkillRegistry + SkillSource interface
src/skills/store.ts       Dexie v3 `skills`; encrypted CRUD
```

`ToolRuntimePorts = { codeRunner?: CodeRunner; workspace?: WorkspaceApi; fetch?: typeof fetch }`.
`buildToolSet(requestedNames, ports)`:
1. pool = builtin provider names available in `ports` + enabled user tool names.
2. selected = `requestedNames.length ? requestedNames ∩ pool : pool`.
3. for each selected name, resolve provider tool, user `sandbox-js` tool, or user
   `http` tool and wrap with
   `tool({ description, inputSchema: jsonSchema(schema), execute })`.
`sandbox-js` execution calls `ports.codeRunner.run(def.source, { timeoutMs })`;
`http` execution calls `executeHttpTool(def.request, input, ports.fetch)`.

## Files to Create / Modify

- Modify: `package.json` (add `yaml@2.9.1`)
- Create: `src/tools/types.ts`
- Create: `src/tools/http.ts`
- Create: `src/tools/http.test.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/store.ts`
- Create: `src/tools/registry.test.ts`
- Create: `src/skills/schema.ts`
- Create: `src/skills/parser.ts`
- Create: `src/skills/registry.ts`
- Create: `src/skills/store.ts`
- Create: `src/skills/parser.test.ts`
- Create: `src/skills/registry.test.ts`
- Modify: `src/vault/db.ts` (version 3: `skills`, `tools` tables)

## Implementation Steps

1. `pnpm add yaml@2.9.1`; confirm the Vite build resolves it.
2. Add `src/tools/types.ts`: union, ports, guards, `ToolNameConflictError`,
   `ToolRuntimeUnavailableError`, `ToolSchemaError`.
3. Add `src/tools/http.ts`: `executeHttpTool(request, input, fetchImpl)` substitutes
   `{{input.a.b}}` only in the path/query, body, and header **values**; rejects any
   template that touches the scheme/host/port; parses the resolved URL and checks
   its origin against `request.allowedOrigins`; applies `AbortSignal.timeout`; caps
   the response body; maps non-2xx to `HttpToolError`.
4. Add `src/tools/registry.ts` with deterministic ordering, the two-level selection
   rule, and `buildToolSet`.
5. Add Dexie `version(3).stores({ vault, meta, threads, skills: 'id, updatedAt',
   tools: 'id, updatedAt' })` and `src/tools/store.ts` / `src/skills/store.ts`
   using Phase 2's record API with `tool:{id}` / `skill:{id}` AAD and the shared
   `vaultWriteQueue` for writes.
6. Add `src/skills/parser.ts` using `yaml.parse` on the frontmatter block; tolerate
   missing frontmatter via `fallbackName`; reject malformed YAML with
   `SkillParseError`.
7. Add `src/skills/schema.ts` and `src/skills/registry.ts` implementing the API
   above; `setEnabled` is the only way a skill participates; `toolNamesFor`
   intersects with the enabled pool.
8. Tests:
   - `http.test.ts`: allowed host works; disallowed origin rejected after
     substitution; authority/header-name interpolation rejected; response cap;
     non-2xx; timeout.
   - `registry.test.ts`: build from provider + user defs; unknown name rejected;
     `sandbox-js` without runner rejects; skill allowedTools cannot widen the pool;
     deterministic order; unsafe schema-key rejection.
   - `parser.test.ts`: `allowed-tools`, folded description, missing frontmatter,
     malformed YAML.
   - `registry.test.ts` (skills): resolve refs, trusted/untrusted source preserved,
     import/update/remove persists encrypted, `setEnabled` gating.
9. `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] `yaml@2.9.1` added and builds
- [x] `src/tools/types.ts`
- [x] `src/tools/http.ts` + hardening tests
- [x] `src/tools/registry.ts` + tests (narrowing rule)
- [x] Dexie version 3 `skills`/`tools` tables
- [x] `src/tools/store.ts`, `src/skills/store.ts` (queue-serialized)
- [x] `src/skills/parser.ts` + tests
- [x] `src/skills/registry.ts` + tests
- [x] lint / build / full test green

## Verification

- `pnpm test -- src/tools src/skills` passes.
- Narrowing test: a workspace skill declaring `allowed-tools: [read_file]` where
  `read_file` is not in the enabled pool yields an empty tool set, not `read_file`.
- `pnpm build` bundles `yaml` without a Node shim.
- Encrypted store test: imported skill instructions absent from raw IndexedDB bytes.
- `pnpm lint` clean.

## Success Criteria

- `buildToolSet` produces a valid `ToolSet` and rejects unavailable runtimes.
- A SKILL.md parses into a manifest; only explicitly enabled skills participate.
- Skills cannot widen the tool set beyond the enabled pool.
- Imported/edited skills and tools persist encrypted and reload.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `yaml` CJS interop under Vite/Rolldown | Verify the import shape in build. |
| User tool names collide with builtins | Registry rejects duplicates with `ToolNameConflictError`. |
| Malformed frontmatter crashes loading | `SkillParseError`; the registry skips and reports bad skills without failing the rest. |
| A workspace skill smuggles tools | Two-level narrowing rule plus a dedicated test. |

## Security Considerations

- `sandbox-js` user tools never execute on the main thread; execution is the
  Phase 5 `CodeRunner`.
- `http` tools execute on the main thread: host allow-list, no authority/header-name
  interpolation, resolved-origin check, and a response cap are mandatory. The
  document `connect-src` is `'self' https:`, so the allow-list — not the CSP — is
  the real control.
- Workspace-sourced skills are untrusted at the composer layer (Phase 1) and can
  only narrow tools here.
- Schema/name guards reject prototype-pollution keys and unsafe tool names.

## Next Steps

Phase 4 registers workspace tools and the workspace skill source; Phase 5 supplies
the `CodeRunner` provider.
