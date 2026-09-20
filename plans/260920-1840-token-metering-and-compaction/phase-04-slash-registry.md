---
phase: 4
title: "Phase 4: Slash command registry and suggestion UI"
status: done
priority: P1
effort: "8h"
dependencies: [3]
---

# Phase 4: Slash command registry and suggestion UI

## Goal

Add a reusable slash surface where built-in commands and installed skills share one namespace: `/compact` compacts the thread, and `/<skill-id>` enables that skill for the thread and appends a hidden directive telling the model to call `load_skill` with that id immediately.

## Context

`src/chat/use-chat-runtime.ts` bridges the engine into assistant-ui through `useExternalStoreRuntime`, and `onNew` receives the composer's text. The composer lives in `src/components/assistant-ui/elements/thread.aui.tsx` and already hosts `ComposerControls`. Radix `Popover` is a dependency and is the pattern `src/ui/composer-controls.tsx` uses for its menus. The composer runtime exposes `text`, `setText`, and `send`, so a suggestion list can complete the input without touching the DOM. `unstable_useSlashCommandAdapter` exists upstream but is marked unstable and its popover companion is not exported by this version, so the UI is built locally against our own registry.

`SkillRegistry` (`src/skills/registry.ts`) exposes `list()`, `isEnabled(ref)`, and `resolve(refs)`. A skill is keyed by `source:id` (`skillKey`), so the same id can exist in both the vault and the workspace.

The load path constrains the design. `buildRunStream` builds the skill port with `createSkillLoadPort(deps.skillRegistry.resolve(config.enabledSkills))`, so `load_skill` can only resolve a skill that the thread has enabled, and `load_skill` and `search_skills` are unioned into the tool set only when `config.enabledSkills` is non-empty. A directive to call `load_skill` therefore has to be paired with enabling the skill on the thread, or the tool call returns null. Enabling also applies the skill's `allowedTools` narrowing through `toolNamesFor`, which is the existing and intended meaning of enabling a skill.

Keeping the body out of the conversation is the point: the directive is a few tokens, and the instructions enter context only when the model actually loads them, through the existing tool path that already handles trusted and untrusted sources.

## Files to Create / Modify

- Create: `src/chat/slash.ts`
- Create: `src/chat/slash.test.ts`
- Create: `src/chat/skill-invoke.ts`
- Create: `src/chat/skill-invoke.test.ts`
- Create: `src/ui/slash-suggestions-state.ts`
- Create: `src/ui/slash-suggestions-state.test.ts`
- Create: `src/ui/slash-suggestions.tsx`
- Create: `src/ui/slash-suggestions.test.tsx`
- Modify: `src/chat/sanitize.ts`
- Modify: `src/chat/use-chat-runtime.ts`
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`

## Implementation Steps

1. In `src/chat/slash.ts`, define `SlashCommand` with `id`, `label`, `description`, `argumentHint?`, and `run(ctx, args)`, where `ctx` carries the session, the active thread id, and the resolved thread. Define `SlashEntry` as the union of a built-in command and a skill entry, so both render and resolve through one list.
2. Add `parseSlashInput(text)` returning `{ name, args, isSlash }` for text whose first non-space character is `/`, where `name` may carry an explicit `@vault` or `@workspace` source suffix.
3. Add `slashEntries(commands, skillRegistry)` returning the built-in commands followed by every globally enabled skill, matching the `isEnabled` filter `ComposerControls` already applies so a disabled skill is never invocable. A built-in command wins any name collision with a skill.
4. Add `resolveSlash(entries, name)`: an exact built-in match first, then a skill match. When one id exists in both the vault and the workspace, an unsuffixed name resolves to the vault entry and the workspace one requires `@workspace`.
5. Add `runSlashCommand(entries, ctx, text)` that resolves the entry, runs it, and throws a typed error naming the available entries when nothing matches.
6. Define the `/compact` command: it calls `compactThread` with the trailing text as optional summarization instructions, persists the result, and starts no model run.
7. In `src/chat/skill-invoke.ts`, add `skillDirectiveMessage(skill)` building a short user message that names the tool and the target, for example: call `load_skill` with id `<id>` and source `<source>` now, then follow the returned instructions for this task. Carry `metadata.skillDirective = { id, source, name }` so the UI can recognise it.
8. Add `invokeSkill(ctx, skill, trailingText)`: add the `SkillRef` to `config.enabledSkills` through `patchThreadConfig` when it is absent, never duplicating an existing ref, and persist the thread. Then append the directive message. When `trailingText` is non-empty, append it as the user message and start the run; when it is empty, start no run, which leaves the directive as the last message so the user's next message follows it directly.
9. In `src/chat/sanitize.ts`, extend `ChatMessageMetadata` with `skillDirective?: { id: string; source: "vault" | "workspace"; name: string }`.
10. In `src/chat/use-chat-runtime.ts`, route `onNew` through `parseSlashInput`: slash text goes to `runSlashCommand`, everything else to `engine.sendTurn`. Errors land on `useChatStore.setError` exactly as the existing catch blocks do.
11. In `src/ui/slash-suggestions-state.ts`, put the interaction logic in pure functions: `suggestionsFor(entries, text)`, `moveHighlight(state, direction)`, and `completionFor(entry, text)` returning the composer text after a selection, including the `@workspace` suffix when the id is ambiguous. The repository runs vitest with `environment: "node"` and tests components through `renderToStaticMarkup`, so keyboard behavior must live outside the component to be testable, matching the existing `plan-view.ts` and `resize.ts` split.
12. In `src/ui/slash-suggestions.tsx`, render a Radix `Popover` anchored above the composer that is open only while the composer text starts with `/`. It lists built-in commands first, then skills with their name, description, and a source tag; it delegates ArrowUp, ArrowDown, Enter, Tab, and Escape to the state module and writes the completion back through the composer runtime's `setText`. Reuse the `TRIGGER`, `ITEM`, and `CONTENT` class constants' visual language from `composer-controls.tsx` rather than inventing new styling.
13. In `thread.aui.tsx`, mount `<SlashSuggestions />` inside the composer shell above the input, and render a message carrying `skillDirective` as a one-line marker naming the skill instead of as a chat bubble, so the directive text stays out of the transcript the user reads while remaining a real message in the thread the model sees.

## Verification

- `pnpm exec vitest run src/chat/slash.test.ts src/chat/skill-invoke.test.ts`
- `pnpm exec vitest run src/ui/slash-suggestions-state.test.ts src/ui/slash-suggestions.test.tsx`
- `pnpm lint`

## Success Criteria

- [x] `parseSlashInput` handles `/compact`, `/compact keep the API notes`, `/my-skill`, `/my-skill@workspace do the thing`, leading whitespace, and a bare `/`.
- [x] The suggestion list shows `/compact` plus every globally enabled skill, and a disabled skill never appears or resolves.
- [x] An unknown name surfaces an error naming the available entries and sends nothing to the model.
- [x] `/compact` appends the boundary and starts no run.
- [x] `/<skill-id>` adds the ref to `config.enabledSkills` when absent, persists the thread, and never duplicates an existing ref.
- [x] After `/<skill-id>`, `buildRunStream` exposes `load_skill` and its port resolves that id, asserted through the existing port helper rather than through a live model call.
- [x] `/<skill-id>` with no trailing text appends only the directive and starts no run; `/<skill-id> <text>` appends the directive, then the text, and starts one run in that order.
- [x] The directive message is at most a couple of lines, so invoking a skill costs a negligible number of tokens compared with its body.
- [x] A message carrying `skillDirective` renders as a one-line marker, not as a chat bubble.
- [x] A duplicate id across sources resolves to the vault entry unsuffixed and to the workspace entry with `@workspace`.
- [x] Adding a built-in command requires only a registry entry and a handler, with no change to `use-chat-runtime.ts`, `thread.aui.tsx`, or `slash-suggestions.tsx`, asserted by a test that registers a fake command and drives it end to end.
- [x] Highlight movement, completion text, and dismissal are covered by pure tests in `slash-suggestions-state.test.ts`; the component test asserts only the static markup of an open list.
- [x] The popover closes on Escape and on send, and Enter reaches the composer normally when no popover is open.
