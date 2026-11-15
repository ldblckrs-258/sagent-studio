---
phase: 5
title: Playground view
status: completed
priority: P2
effort: 5h
dependencies: [1, 2, 3, 4]
---

# Phase 5 — Playground view

## Goal

The user switches the shell to Playground, sets provider tokens, picks a provider and model, fills the generated form, runs it, and works with results in a gallery, without losing sight of pending chat approvals.

## Files

- Create:
  - `src/ui/playground/playground-view.tsx`
  - `src/ui/playground/model-picker.tsx`
  - `src/ui/playground/schema-form.tsx`
  - `src/ui/playground/run-gallery.tsx`
  - `src/settings/PlaygroundProvidersSection.tsx`
- Modify:
  - `src/ui/shell.tsx`: view switch, sessionStorage state, approval badge.
  - `src/settings/ProvidersPanel.tsx`: render `PlaygroundProvidersSection` after `TypeSafeSection` (`:426`).
  - `src/ui/composer-upload.ts`: export `EXTENSION_BY_MEDIA_TYPE` (`:51`).
- Tests:
  - `src/ui/playground/playground-view.test.tsx`
  - `src/ui/playground/schema-form.test.tsx`
  - `src/settings/PlaygroundProvidersSection.test.tsx`

## Steps

1. **View switch (`shell.tsx`).**
   - `type ShellView = 'chat' | 'playground'`, stored under `sagent.view.v1` in sessionStorage with the guard and fallback of `readRailState` (`:121`).
   - A two-tab segmented control in the header (`:483`) with `role="tablist"`, `aria-selected`, and the arrow-key handling from `chat-config.tsx`.
   - In `playground`, the main content block (`:534`–`:543`) renders `<PlaygroundView />` through `lazy()` like `TerminalPanel` (`:60`). The Conversations sidebar is hidden and the rail stays.
   - The Chat tab shows a badge when `findPendingApproval` over the active thread's messages (as in `src/ui/approval-prompt.tsx:24`) returns a request, and plays the approval chime once per approval id.
   - When `useAgentPanelStore` `selectedRunId` becomes non-null, the view switches to `chat`.
2. **Provider tokens (`PlaygroundProvidersSection`).**
   - One block per `listProviders()` entry: `SecretField` with the provider's `tokenLabel` and a link to `tokenUrl`, an optional base URL `Input` with `defaultBaseURL` as placeholder, a debounced save like `TypeSafeSection`, and a **Check token** button calling `verify()`.
   - Saving through `setPlaygroundProvider`. An invalid base URL shows the setter's error inline. A blank token clears the entry.
3. **Playground view.**
   - Calls `hydrate` once on mount.
   - No provider with a token: `EmptyState` with a button that opens Config → Providers.
   - At ≥ 1024 px: a 360 px left column (provider select, model picker, form) and the gallery filling the rest. Below that, stacked.
   - Shows a notice when `skipped > 0` ("N runs could not be read").
4. **Model picker.**
   - Provider `Select` (only providers with a token), quick-list `Select` from the provider's `quickModels`, and an `owner/name` `Input` validated with `slugPattern`.
   - Resolves through `usePlaygroundStore` (cached in `models`). Shows the description as plain text and an "Edits images" `Badge` when `imageFields` is non-empty. Errors render inline.
5. **Schema form.**
   - Field kinds map to `Textarea`, `Input`, `Select`, a native `<input type="range">` paired with a number `Input`, `Toggle`, and a JSON `Textarea`. All labels and descriptions render as text, never markdown or HTML.
   - `image` and `images`: file picker and drop target, `image/*`, thumbnails through object URLs revoked on removal and unmount, 25 MB cap.
   - Secret fields: a plain password `Input` (not `SecretField`, whose stored mode would fake a saved value), with a warning: "This value goes to the model author `<owner>`. It is never saved."
   - **Run**: `prepareImage` for each file, `toProviderInput`, `storableInput`, then `usePlaygroundStore.start`. `FormInputError` highlights the field.
6. **Run gallery.**
   - Newest first. Each card: model label, first line of the prompt, status `Badge`, predict time, output thumbnails through `imageUrl` / `releaseImageUrl` on mount and unmount.
   - Active runs show a progress line and **Cancel**. `expired` and `interrupted` runs explain why.
   - Thumbnail click opens `ImageZoom` (`src/components/assistant-ui/elements/image.tsx:264`).
   - Actions:
     - **Use settings** loads provider, model, input, and stored input images into the form. Secret fields stay empty and required.
     - **Re-run** is the same, then runs immediately when the run has no `secretFields`. Otherwise it only loads the form.
     - **Download** writes the blob through `<a download>` named `<model-name>-<run-id>-<index>.<ext>`, with `<ext>` from `EXTENSION_BY_MEDIA_TYPE`, falling back to the URL's extension.
     - **Save to folder**: in the click handler, first restore or choose the Playground folder and `ensureFolderPermission`, then load the image and `saveToFolder`. The button label names the folder. A **Change folder** action calls `choosePlaygroundFolder`.
     - **Delete** removes the run.

## Verification

- `pnpm exec vitest run src/ui/playground src/settings/PlaygroundProvidersSection.test.tsx`
- jsdom tests (`// @vitest-environment jsdom`, `createRoot` and `act`, as in `src/ui/panels/memory.test.tsx`):
  - no token shows the empty state; a fake provider run reaches `succeeded` with a thumbnail; Cancel calls the provider's `cancel`; Use settings refills the form and leaves secrets empty;
  - Re-run of a run with `secretFields` does not call `start`;
  - each field kind renders and returns values; a file over 25 MB is rejected; a schema description containing `<img onerror>` renders as text;
  - the view switch persists to `sagent.view.v1` and falls back to `chat` on a bad value; a pending chat approval shows the badge in Playground; selecting an agent run switches to `chat`;
  - the providers section lists the registry entries and shows the setter's error for `//evil.example`;
  - Save to folder never calls `useWorkspaceStore` `pick`.
