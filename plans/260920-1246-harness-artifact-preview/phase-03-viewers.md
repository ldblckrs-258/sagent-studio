---
phase: 3
title: "Markdown and JSON Viewers"
status: implemented
priority: P1
effort: "7h"
dependencies: [2]
---

# Phase 3: Markdown and JSON Viewers

## Context Links

- `src/ui/file-view/kind.ts` — `FileKind` union, extension sets, labels.
- `src/ui/file-view/html-view.tsx` — Preview/Source toggle pattern to reuse.
- `src/ui/file-view/text-view.tsx` — editor + save bar pattern.
- `src/ui/file-view/use-text-document.ts` — load/save hook.
- `src/ui/file-view/load.ts:7` — `REMOTE_TEXT_CAP` (5 MB) bounds remote input.
- `src/workspace/fs.ts:50` — `DEFAULT_SIZE_CAP` (2 MB) bounds workspace input.
- `src/ui/file-view/kind.test.ts:37,46` — assertions that must change (`md` is `null`; remote `.md` is `embed`).
- `src/ui/panels/file-editor.tsx:120-132` — dispatch to add.
- `pnpm-lock.yaml:2408` — `react-markdown@10.1.0` already resolved under `@assistant-ui/react-markdown`.

## Goal

Render Markdown and JSON artifacts as formatted views with a Source toggle, so model-produced docs and data files open usefully instead of as raw text.

## Requirements

- Functional: `.md`/`.markdown` render as Markdown; `.json` renders as a tree.
- Functional: both kinds keep a Source view; workspace sources stay editable and saveable.
- Functional: invalid JSON shows a clear error and falls back to Source rather than failing.
- Functional: the JSON tree caps rendered siblings per level so a wide document cannot freeze the tab.
- Non-functional: reuse `useTextDocument`/`useRemoteText`, `ViewerLoading`/`ViewerError`, and a shared mode toggle instead of new state hooks.
- Non-functional: remote `.md`/`.json` links route to the new viewers too.

## Architecture

`kindForExtension` gains `markdown` and `json`. `FilePanel`'s switch (`file-editor.tsx:120-132`) gains two branches. Each new viewer mirrors `HtmlView`: a mode toggle, an editor via `useTextDocument` (workspace) or `useRemoteText` (url), and a formatted renderer. Unknown workspace extensions still fall back to `text`. `jsonc` is intentionally not in scope: `JSON.parse` cannot read its comments or trailing commas, so mapping it here would guarantee a permanent error state.

## Related Code Files

Create:

- `src/ui/file-view/viewer-mode-toggle.tsx` — extracted Preview/Source toggle.
- `src/ui/file-view/markdown-view.tsx` — the Markdown viewer.
- `src/ui/file-view/json.ts` — pure parse/format helpers.
- `src/ui/file-view/json.test.ts` — helper tests.
- `src/ui/file-view/json-view.tsx` — the JSON viewer.

Modify:

- `package.json` — add `react-markdown`.
- `src/ui/file-view/kind.ts` — new kinds, extensions, labels.
- `src/ui/file-view/kind.test.ts` — updated `md`, remote, and `json` expectations.
- `src/ui/file-view/html-view.tsx` — use the extracted toggle (dedupe).
- `src/ui/panels/file-editor.tsx` — dispatch branches.

## Implementation Steps

1. Add `react-markdown@10.1.0` to `dependencies` in `package.json` (exact version matches the lockfile resolution) and run `pnpm install`.

2. In `src/ui/file-view/kind.ts`:
   - Extend `FileKind` with `'markdown' | 'json'`.
   - Add `MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])` and `JSON_EXTENSIONS = new Set(['json'])`.
   - Map them in `kindForExtension` before the final `return null`.
   - Add labels `markdown: 'Markdown'`, `json: 'JSON'` to `KIND_LABELS`.

3. Create `src/ui/file-view/viewer-mode-toggle.tsx` exporting `ViewerModeToggle` with Props `{ mode: 'preview' | 'source'; onChange(mode): void }`, moving the markup from `ModeToggle` in `html-view.tsx`. Update `html-view.tsx` to import it and drop the local copy.

4. Create `src/ui/file-view/json.ts` with pure helpers so they are unit-testable without React:

   ```ts
   export type JsonParse =
     | { ok: true; value: unknown }
     | { ok: false; message: string }

   export function parseJsonDocument(text: string): JsonParse
   export function formatJsonDocument(text: string): string | null  // pretty-print, null when invalid
   export function jsonValueLabel(value: unknown): string           // 'object', 'array(3)', 'string', ...
   ```

   `parseJsonDocument` trims, returns `{ ok: true, value: JSON.parse(trimmed) }` or `{ ok: false, message }`. An empty document parses as `ok` with `value: null`.

5. Create `src/ui/file-view/json-view.tsx`:
   - Load with `useTextDocument(fs, workspacePath)` or `useRemoteText(remoteUrl)`, following `text-view.tsx`.
   - Default mode `preview`. On `parseJsonDocument` failure, show `ViewerError` and force the Source view (keep the toggle so the user can return after fixing).
   - Tree renderer: a recursive `JsonNode` using `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` from `src/components/ui/collapsible.tsx` for objects and arrays, with `jsonValueLabel` for collapsed summaries; scalars render as `font-mono` spans with distinct classes per type.
   - **Sibling cap:** export `MAX_JSON_CHILDREN = 100`. Render at most that many children per level with a "Show N more" button that raises a local visible count. This bounds a wide `{"rows":[…200k…]}` document even though collapsing only hides children, not siblings.
   - Source mode uses `MonacoEditor` with `languageFor(path)`; for workspace targets keep the editable save/cancel bar from `text-view.tsx`; for remote targets stay read-only like `TextView`.

6. Create `src/ui/file-view/markdown-view.tsx`:
   - Same load/save shape as `json-view.tsx`.
   - Preview mode: `import Markdown from 'react-markdown'` and `remarkGfm`, with a local `components` map that styles headings, paragraphs, lists, blockquotes, tables, inline code, and code blocks using the app tokens (`text-ink`, `bg-paper-sunk`, `font-mono`, `border-rule`). Wrap the output in a padded, `overflow-y-auto` container.
   - Source mode: `MonacoEditor` with `languageFor(path)` (`markdown`), editable with save for workspace targets.

7. Update `src/ui/panels/file-editor.tsx` to add the two branches:

   ```tsx
   {kind === 'markdown' ? <MarkdownView fs={fs} target={target} /> : null}
   {kind === 'json' ? <JsonView fs={fs} target={target} /> : null}
   ```

8. Update `src/ui/file-view/kind.test.ts`:
   - Change `expect(kindForExtension('md')).toBeNull()` (line 37) to `.toBe('markdown')`; add `markdown` and `json` mappings.
   - Change `expect(kindForRemote('https://x.test/notes.md')).toBe('embed')` (line 46) to `.toBe('markdown')`; add `kindForRemote('https://x.test/data.json') === 'json'`; keep the other fallback assertions.
   - Keep the unknown-extension fallback assertions (`README`, `src/index.ts` → `text`) intact.

9. Add `src/ui/file-view/json.test.ts` covering `parseJsonDocument` (valid object, valid array, scalar, empty, invalid), `formatJsonDocument` (pretty-prints, `null` on invalid), `jsonValueLabel` (object, array length, string, number, boolean, null), and `MAX_JSON_CHILDREN` being a positive integer.

## Verification

```bash
pnpm vitest run src/ui/file-view/kind.test.ts src/ui/file-view/json.test.ts
pnpm lint
pnpm build
```

## Todo

- [ ] Add `react-markdown` and install.
- [ ] Add `markdown` and `json` kinds, extensions, and labels.
- [ ] Extract `ViewerModeToggle` and reuse it in `html-view.tsx`.
- [ ] Add `json.ts` helpers with tests.
- [ ] Add `json-view.tsx` with tree, sibling cap, and error fallback.
- [ ] Add `markdown-view.tsx` with formatted preview + source.
- [ ] Wire both branches in `file-editor.tsx`.
- [ ] Update `kind.test.ts` lines 37 and 46 plus new json cases.

## Success Criteria

- A workspace `.md` file opens as formatted Markdown with a working Source toggle and save.
- A valid `.json` file opens as an expandable tree; invalid JSON shows an error and the source; a wide array renders at most `MAX_JSON_CHILDREN` siblings until expanded.
- Remote `.md`/`.json` links open in the new viewers.
- Unknown extensions still open as `text`; `.jsonc` still opens as `text`.
- `kind.test.ts`, `json.test.ts`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `react-markdown` duplicates shared unified packages | Pin to `10.1.0`, the version already resolved; check `pnpm why react-markdown` after install |
| JSON tree recursion on deeply nested or wide documents | Collapse nodes by default, cap siblings per level, and rely on the existing read size caps |
| Styling divergence between chat markdown and the new viewer | Use app tokens and keep the components map small; visual check in the browser gate |
| A stale remote `.md` expectation fails the phase gate | Explicitly update `kind.test.ts:46` in step 8 |

## Security Considerations

- Markdown rendering must not inject raw HTML. Do not enable `rehype-raw`; `react-markdown` escapes HTML by default.
- Remote Markdown/JSON stays read-only and is fetched through the existing capped `useRemoteText` path.
- JSON parsing is pure and never evaluated.

## Next Steps

Phase 4 adds the Mermaid diagram viewer and runs the full test, lint, and build gate.
