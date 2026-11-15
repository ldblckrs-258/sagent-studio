---
status: in-progress
created: 2026-10-26
---

# Playground UI/UX pass and raw JSON input mode

## Outcome
The Playground reads as one tool: the left panel is the run config with a Form or JSON mode, the right panel is a contact sheet of runs with uncropped outputs.

## Constraints
- Keep the house system: Parchment & Teal tokens, Archivo + JetBrains Mono, sharp 2-3px radii, product motion only (150-250ms).
- No new dependencies. Reuse `MonacoEditor` (lazy, textarea fallback) for JSON.
- Secrets typed in either mode are never stored. JSON keys the schema does not declare are stripped from storage when their name looks sensitive.
- Existing test selectors (`Quick pick`, `Prompt`, `Run`, `Use settings`, `Re-run`, `Download`, `Save to folder`, `Retry download`, `Cancel`) keep working.

## Non-goals
- Editing the whole HTTP body (version, webhook). JSON mode edits the prediction `input` object, which is the body's only user-owned part.
- New providers, storage changes, or gallery pagination.

## Acceptance criteria
1. A Form | JSON switch sits above the inputs. Switching to JSON shows the current form values as JSON; switching back fills the form and names keys the form cannot show.
2. JSON mode runs the parsed object as the input. Invalid JSON or a non-object blocks the run with a message. Images attached in Form mode are uploaded for image fields the JSON leaves out.
3. "Use settings" and "Re-run" refill both modes.
4. Once a model loads, the picker collapses into a model header with a Change action.
5. Optional parameters sit in a collapsible group; prompts, images, and required fields stay on top.
6. The Run bar stays visible at the bottom of the config panel; Ctrl/Cmd+Enter runs from either mode.
7. Outputs render at their own aspect ratio; actions overlay the image on hover and focus and are always visible on touch.
8. Active runs show an indeterminate sweep, elapsed seconds, and a placeholder tile.
9. Vitest, `tsc -b`, and lint stay green.

## Files
- `src/playground/form.ts` (+test): `draftInput`, `valuesFromInput`, `parseInputJson`, `storableInput` sensitive-key rule.
- `src/ui/playground/playground-view.tsx` (+test): mode state, JSON run path, sticky run bar, shortcut.
- `src/ui/playground/model-picker.tsx`: collapsed model header.
- `src/ui/playground/schema-form.tsx` (+test): grouped fields.
- `src/ui/playground/json-input.tsx`: JSON editor panel.
- `src/ui/playground/run-gallery.tsx`: contact-sheet cards.

## Result (2026-10-26)
- Criteria 1-8 implemented and covered by tests in `src/playground/form.test.ts`, `src/ui/playground/playground-view.test.tsx`, `src/ui/playground/schema-form.test.tsx`.
- Gates: vitest 182 files, 2182 passed, 1 skipped (one unidentified full-suite flake in 1 of 5 runs; playground suites 8/8 clean). `tsc -b` and lint clean.
- Pending: visual check in the browser (needs the user's unlocked vault).

## Follow-up: run history views (2026-10-26)
- List | Gallery switch in the Runs header. Gallery is a masonry wall of every output with Use settings, Download, and Save on each tile, plus placeholders for running runs.
- List cards collapse to their header (chevron button with `aria-expanded`); header has Collapse all / Expand all.
- Runs with identical settings (provider, model, version ref, canonical input, secret field names, input image name/type/size) group under one card with a run count; each run keeps its own status, outputs, and delete. Grouping lives in `src/playground/run-groups.ts`.
- Gates: vitest 2188 passed, 1 skipped (2/2 full runs clean); `tsc -b` and lint clean. Browser check still pending.
