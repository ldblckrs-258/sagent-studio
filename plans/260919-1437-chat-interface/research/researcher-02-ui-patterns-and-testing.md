---
title: "UI patterns, design system, and test strategy for the three-column chat shell"
date: 2026-09-19
plan: 260919-1437-chat-interface
role: technical research (researcher-02)
status: final
---

# UI patterns, design system, and test strategy

## Bottom line up front

The repo has a real, coherent house design system (`src/index.css` `@theme` tokens plus
`src/ui/primitives.tsx`), a vendored assistant-ui element kit already remapped onto that
palette, and a shadcn layer (`src/components/ui/*`) that the vendored files depend on.
Two parallel button/input systems now coexist: house primitives use the `src/ui/*` app
style (relative imports, single quotes, no semicolons), while the vendored chat and shadcn
files use `@/` aliases, double quotes, and semicolons. A new shell must pick one style per
area and not blur them.

The most consequential finding is architectural, not visual: **no application code
instantiates the chat engine or any registry**. `SkillRegistry`, `ToolRegistry`,
`createCodeToolProvider`, `workspaceToolProvider`, `JsRunner`, `PyRunner`, `createEngine`,
`useExternalStoreRuntime`, and `AssistantRuntimeProvider` appear only inside `*.test.ts*`
files. The UI plan therefore has to add an app-level composition/session layer before any
panel can be wired, and it has to add persisted-settings slots (default provider, sandbox
config) plus enablement persistence (skills have none; tools need `setEnabled` paired with
`toolStore.save`). `ThreadSummary` carries no title or workspace label, so the left column
must load threads to title them or snapshot a label.

Test reality: Vitest runs in `environment: 'node'` with `fake-indexeddb` only. There is no
jsdom/happy-dom, no `@testing-library/*`, and no browser runner installed. The single
`.test.tsx` uses `renderToStaticMarkup` from `react-dom/server`. A UI plan can mechanically
test pure logic, stores, reducers, serializers, and server-render smoke of pure
presentational components; anything requiring events, effects, portals, the assistant-ui
runtime, workers, Pyodide, or the File System Access picker needs a browser gate.

---

## 1. Design system: tokens, classes, and conventions to reuse

All color, size, radius, easing, and spacing resolves to `@theme` custom properties in
`src/index.css`; there is no `tailwind.config.*` (Tailwind v4 CSS-first; `components.json`
sets `tailwind.config` to empty, `components.json:6-12`).

**Palette and semantics** (`src/index.css:18-36`): `paper`, `paper-sunk`, `surface`, `ink`,
`muted`, `faint`, `rule`, `rule-strong`, `accent`, `accent-hover`, `accent-soft`,
`accent-rule`, `danger`/`danger-soft`/`danger-rule`, `caution`/`caution-soft`/`caution-rule`,
`positive`. Note the deliberate meaning collision: house `muted` is a **text** color
(`oklch(0.5 …)`, `index.css:22`) and house `accent` is the brand cobalt blue
(`index.css:26`), not shadcn's neutral hover surface.

**Radius** (`index.css:38-39`): `--radius-sm: 2px`, `--radius-md: 3px`; bridged
`--radius-lg: 4px`, `--radius-xl: 6px` for shadcn elements (`index.css:85-86`). House
controls use `rounded-sm`; vendored chat surfaces use `rounded-md`/`rounded-lg`/`rounded-xl`
and the assistant-ui `--composer-radius: 1rem` (`thread.aui.tsx:198`).

**Easing** (`index.css:41-42`): `--ease-out-quart`, `--ease-out-quint`. House controls use
`ease-out-quart` at `duration-150` (e.g. `primitives.tsx:30`, `:61`).

**Type scale** (`index.css:44-51`): `xs 0.75rem`, `sm 0.833rem` (note: not the Tailwind
default 0.875rem), `base 1rem`, `lg 1.2rem`, `xl 1.44rem`, `2xl 1.728rem`, `3xl 2.074rem`,
`4xl 2.52rem`. Fonts: `--font-display`/`--font-sans` are Archivo, `--font-mono` is
JetBrains Mono (`index.css:14-16`), loaded in `main.tsx:3-4`.

**Mono usage**: `code, kbd, samp` get the mono family with ligatures disabled
(`index.css:159-164`); identifiers, endpoints, model ids, and error strings render mono
(`ProvidersPanel.tsx:112`, `:148`, `model-manager.tsx:105`, `:149`, `:207`).

**Min touch target**: house controls use `min-h-11` (2.75rem / 44px) on buttons and inputs
(`primitives.tsx:30`, `:61`) and `size-11` on icon buttons (`shortcuts.tsx:48`,
`model-manager.tsx:215`). Buttons also carry `after:absolute after:-inset-1` to enlarge the
hit region without visual change (`primitives.tsx:30`). This is a real divergence from the
vendored assistant-ui controls, which use compact `size-6`/`size-7` (`tooltip-icon-button.tsx:33`,
`thread.aui.tsx:489`); the plan should keep the 44px target for shell chrome and panels, and
accept the vendored compact sizing inside the thread.

**`.label-micro`** (`index.css:178-184`): mono, `xs`, `letter-spacing .08em`, uppercase,
`faint`. Used for section eyebrows (`App.tsx:26`, `UnlockScreen.tsx:40`, `:57`,
`shortcuts.tsx:58`, `model-manager.tsx:208`). Also `.rule-top` (`index.css:186-188`) and
`.numeric` (tabular-nums, `index.css:190-192`) are available house utilities.

**Focus rings**: global `:focus-visible { outline: 2px solid var(--color-accent);
outline-offset: 2px }` (`index.css:166-169`). Shadcn elements instead use
`focus-visible:ring-[3px] focus-visible:ring-ring/50` with `--color-ring` mapped to
`--color-accent` (`index.css:83`, `components/ui/button.tsx:7`). Both are acceptable; do not
introduce a third focus treatment. Selection is accent-on-surface (`index.css:171-174`).

**Motion**: state-conveying only. `@keyframes panel-in` translates `-4px → 0`
(`index.css:196-205`), used at `Shortcuts.tsx:56` (`180ms ease-out-quint`) and
`ProvidersPanel.tsx:135` (`200ms ease-out-quart`). A global `prefers-reduced-motion` block
forces animation/transition durations to `0.01ms` (`index.css:207-215`). `Spinner` uses
`motion-safe:animate-spin` (`shortcuts.tsx:11`). New panels should reuse `panel-in` rather
than author new entrance animations.

**Dark mode mechanism**: `@media (prefers-color-scheme: dark)` redefines the same custom
properties in `:root` (`index.css:89-111`) and `html { color-scheme: light dark }`
(`index.css:114-116`). There is no class-based toggle and no `.dark` selector; every token
therefore follows the OS automatically. Dark is a deliberately separate palette in the same
hue family (`index.css:5-12`), not an inversion. Because the tokens themselves flip, most
`dark:` variants in the vendored files are redundant; keeping them is harmless but they are
not the mechanism.

**How `@theme inline` bridges assistant-ui** (`index.css:67-87`): shadcn semantic names are
mapped onto house tokens — `background→paper`, `foreground→ink`, `card/popover→surface`,
`primary→accent`, `secondary→paper-sunk`, `muted-foreground→muted`, `destructive→danger`,
`border→rule`, `input→rule-strong`, `ring→accent`. The vendored elements are authored against
those shadcn names and inherit the paper/ink/accent system as a result
(`index.css:54-66`).

**House tokens that are NOT defined as shadcn names**: `--color-accent`,
`--color-accent-foreground`, and `--color-muted` are deliberately absent from the bridge
(`index.css:62-66`). `accent` resolves to the house brand cobalt and `muted` to the house
faint-text color instead of a neutral hover background. The vendored files were remapped to
`bg-accent-soft` / `bg-paper-sunk` wherever shadcn meant a hover surface (e.g.
`/components/ui/button.tsx:15,19`, `thread-list.aui.tsx:233`, `thread.aui.tsx:655,663`). Any
new component copied from shadcn that uses `bg-accent`, `text-accent-foreground`, or
`bg-muted` will hit the house semantic by accident; use `accent-soft`, `paper-sunk`,
`text-muted` deliberately.

**Other Tailwind v4 wiring**: `@import "tailwindcss"`, `tw-shimmer`, `tw-animate-css`
(`index.css:1-3`); `data-open`/`data-closed` custom variants (`index.css:221-227`); collapsible
keyframes (`index.css:233-250`). Tailwind is wired through `@tailwindcss/vite`
(`vite.config.ts:2,62`).

## 2. Component conventions

**House primitives (`src/ui/primitives.tsx`)** are the app's structural kit:

- `Button` with `variant: 'primary' | 'secondary' | 'quiet' | 'danger'`
  (`primitives.tsx:7-18`), an optional `icon` slot, and the shared base class
  (`primitives.tsx:30`). Default variant is `secondary` (`primitives.tsx:21`).
- `Input` wraps a shared `CONTROL` class (`primitives.tsx:60-65`) — full width, `min-h-11`,
  `rounded-sm`, focus-to-accent.
- `Field` is the labeled-control unit with an `error` slot that renders
  `<span role="alert">` (`primitives.tsx:38-58`).
- `Row` is the page's structural unit: label left, control right, ruled top, responsive
  `sm:grid-cols-[13rem_1fr]` (`primitives.tsx:68-94`), with hint and error slots
  (`:82-91`).

`ProvidersPanel` is the reference consumer. It imports `Button, Input, Row` and `Spinner`
(`ProvidersPanel.tsx:11-12`), validates with `validateProvider` before saving
(`:68-80`), persists through `useVaultStore.getState().update({ providers: list })`
(`:301-309`), and lays out each field as a `Row` with a `Field`-style error passed through
the `error` prop (`:136-169`). Its `SectionHeader` (`:29-47`) is the pattern for panel
headings (title + description + optional action) and is local, not exported. Connection
feedback is a `role="status"` line with a positive/danger color (`:200-214`).

**shadcn layer (`src/components/ui/*`)** currently provides `button`, `input`, `textarea`,
`dialog`, `tooltip`, `collapsible`, `skeleton`, `avatar`. These are the standard
`new-york`, `neutral` base-color, `cssVariables: true` outputs (`components.json:3-12`) using
`class-variance-authority` and the single `radix-ui` package (`components/ui/button.tsx:1-4`,
`:50`; `dialog.tsx:4`; `tooltip.tsx:5`). The vendored assistant-ui elements consume this layer
(`thread.aui.tsx:26-27`, `tool-fallback.aui.tsx:26-29`, `thread-list.aui.tsx:3-5`). **No
application UI code outside `src/components/**` imports from `src/components/ui/*`** (verified
by alias scan; see below), so reusing shadcn primitives in the new shell is a deliberate
choice, not the current default.

**`cn`** (`src/lib/utils.ts:1-7`) is `twMerge(clsx(inputs))`: conditional class joining with
Tailwind conflict resolution. It is used only by shadcn and vendored components. House
primitives concatenate template strings instead (`primitives.tsx:30`, `:64`).

**Import alias rules**: `@` maps to `./src` in Vite (`vite.config.ts:69-73`), in
`tsconfig.app.json` `paths` (`tsconfig.app.json:12-14`), and in `tsconfig.json`
(`tsconfig.json:8-11`); `components.json` documents the intent (`components.json:14-20`).
The actual usage split is clean: **all 47 `@/` imports in `src/` are under
`src/components/**`**; every other area (`App.tsx`, `settings/*`, `ui/*`, `ai/*`, `vault/*`,
`chat/*`, `skills/*`, `tools/*`, `workspace/*`, `sandbox/*`) uses relative imports. New shell
files under `src/chat/` or `src/ui/` should use relative imports and match house style; files
added under `src/components/**` should use `@/` and match vendored style. `main.tsx:6` is the
one exception that imports with an explicit `.tsx` extension (`./App.tsx`); extensionless
relative imports are the norm elsewhere.

**React Compiler is active** (`vite.config.ts:63`, `babel({ presets: [reactCompilerPreset()] })`),
so new components must be Compiler-safe (no ref reads during render, no mutating props/state).
Vendored files are exempted from some React lint rules precisely because they are not
(`eslint.config.js:22-33`).

**Icons**: `lucide-react` everywhere, `strokeWidth={1.75}` for chrome, `aria-hidden="true"` on
decorative icons, accessible name on icon-only controls (`App.tsx:34`, `ProvidersPanel.tsx:194`,
`shortcuts.tsx:46-47`).

## 3. Layout: how the unlocked app composes today

`App` routes on vault presence/status (`App.tsx:51-89`): `recovering`/`partial` → recovery
screen, `presence === null` → a mono "Opening local vault" spinner (`App.tsx:68-75`),
`status === 'unlocked'` → `UnlockedApp`, else `UnlockScreen`. Every branch is wrapped in
`ErrorBoundary`. The root is mounted in `main.tsx:33-38` under `StrictMode`.

`UnlockedApp` (`App.tsx:14-49`) is the shell a three-column layout would replace:

- `useIdleLock(settings?.idleLockMinutes ?? 15, true, () => void lock())` (`App.tsx:18`).
- A sticky header: `sticky top-0 z-20 border-b border-rule bg-paper/85 backdrop-blur-sm`
  (`App.tsx:22`), inner row `mx-auto flex h-16 max-w-5xl items-center justify-between gap-6
  px-6 sm:px-8` (`App.tsx:23`), brand on the left (`:24-27`), `Shortcuts` + a secondary
  `Lock` button on the right (`:28-38`).
- `<main className="mx-auto max-w-5xl px-6 pb-32 pt-14 sm:px-8 sm:pt-20">` (`App.tsx:42`)
  containing, in order, `StorageWarning`, `DataEgressNotice`, `ProvidersPanel`
  (`App.tsx:43-45`).

**Max-width containers**: the app currently caps content at `max-w-5xl` (64rem) in both the
header and main (`App.tsx:23,42`). `UnlockScreen` uses a split
`lg:grid-cols-[1fr_minmax(0,40rem)]` (`UnlockScreen.tsx:38`). The vendored thread uses its own
`--thread-max-width: 44rem` inside a full-height `@container` (`thread.aui.tsx:192-208`). A
three-column shell must decide whether the shell is full-bleed (fixed left rail + fluid center
+ right rail) or remains inside `max-w-5xl`; the current `max-w-5xl` constraint would starve a
right rail and should be lifted for the shell, with the center thread keeping its 44rem
reading width.

**Where the existing notices mount**: `StorageWarning` (`settings/StorageWarning.tsx`),
`DataEgressNotice` (`settings/DataEgressNotice.tsx`), and `ProvidersPanel`
(`settings/ProvidersPanel.tsx`) are plain stacked children of the single `<main>`
(`App.tsx:43-45`). They are self-contained (each reads `useVaultStore` and returns `null` when
not applicable, e.g. `StorageWarning.tsx:12`, `DataEgressNotice.tsx:8`), so the shell can
relocate them into the right-rail Vault/Providers tabs without changing them. The brainstorm
already chose the tabbed right rail for exactly this (`brainstorm-…:204-209`).

## 4. State: shapes, subscriptions, lock teardown, and what the UI must add

**`useVaultStore`** (`src/vault/store.ts`): a Zustand store created at `:217`. `VaultState`
(`:32-48`) holds `status: 'locked' | 'unlocking' | 'unlocked' | 'recovering'`, `presence`,
`settings: Settings | null`, `persistedStorage`, `unlockGeneration`, `error`, plus actions
`refreshPresence`, `setup`, `unlock`, `lock`, `update`, `recover`, `clearError`,
`requestPersistentStorage`. Components subscribe with selectors, e.g.
`useVaultStore((s) => s.settings)` (`App.tsx:15`, `ProvidersPanel.tsx:281`). Imperative reads
use `useVaultStore.getState()` (`ProvidersPanel.tsx:88`). `settings` is `null` whenever the
vault is not unlocked (`store.ts:301-306`).

`update(patch)` is the single settings write path (`store.ts:309-320`): it deep-merges into
current `settings` via `deepMerge` (`store.ts:316`, `settings.ts:76-91`), encrypts, persists
through `vaultWriteQueue`, and only then updates the store. Concurrent updates merge rather
than clobber (tested in `store.test.ts:99-115`). `DeepPartial` typing (`settings.ts:64-68`)
means a panel calls `update({ providers: list })` or `update({ typesafe: { apiKey } })`.

**`useChatStore`** (`src/chat/store.ts`): Zustand at `:20`. `ChatState` (`:7-18`) holds
`threads: Record<string, ChatThread>`, `activeThreadId`, `status: 'idle' | 'streaming'`,
`error`, and actions `setThread`, `removeThread`, `setActiveThread`, `setStatus`, `setError`,
`clear`. `setThread` is an upsert (`:26-28`); `removeThread` also clears `activeThreadId` when
it matches (`:30-39`). The engine writes messages into this store (`engine.ts:202-215`), and a
new thread is loaded lazily via `requireThread` (`engine.ts:201-209`).

**Idle lock**: `useIdleLock(timeoutMinutes, enabled, onIdle)` (`use-idle-lock.ts:5-38`)
listens to pointerdown/keydown/mousemove/visibilitychange, resets on visibility-visible, and
is inert when disabled or `timeout <= 0`. `App.tsx:18` wires it to `settings.idleLockMinutes`
(default 15 from `settings.ts:58`).

**Vault-lock teardown**: `lock()` synchronously clears the keyring, invalidates memoized
clients, drains the write queue, then sets `status: 'locked'` and `settings: null`
(`store.ts:295-307`). The chat store subscribes to `useVaultStore` at module scope and, on any
`unlocked → not-unlocked` transition, aborts every registered run and clears threads
(`chat/store.ts:71-76`). Runs register via `registerAbortAll` (`chat/store.ts:60-65`), and the
engine registers a callback that aborts all `AbortController`s (`engine.ts:148-150`); `cancel`
awaits the in-flight run (`engine.ts:194-199`). A UI plan does not need to re-implement this;
it only needs to render `status`/`error` and ensure the thread unmounts cleanly when
`activeThreadId` becomes `null`.

**How a panel reads settings and persists changes**: read via a selector on `settings`
(possibly `null`), write via `update(patch)`. That is proven by `ProvidersPanel`
(`:281-313`) and `DataEgressNotice` (`:5-6,30`). There is no separate settings context.

**Gaps the plan must fill**:

- `Settings` has **no global default provider** (`settings.ts:30-37`); each `ProviderConfig`
  has its own `defaultModel` (`settings.ts:12`). `defaultThreadConfig(providerId, modelId?)`
  *requires* a `providerId` (`chat/types.ts:38-47`), and `ThreadConfig.providerId` is
  validated non-empty (`chat/types.ts:104-107`). A new-thread flow must choose first provider
  or the plan must add a global default (this is the brainstorm's unresolved question 5,
  `brainstorm-…:248`).
- `Settings` has **no sandbox config** (`settings.ts:30-37`): no enablement, no default
  timeouts. The brainstorm's option 4 already scopes an additive slice
  (`brainstorm-…:196-202`); `deepMerge` tolerates additive fields without a version bump
  (`settings.ts:76-91,93-106`).
- There is **no app-side `WorkspaceFs` store**; the handle is persisted but nothing holds the
  live instance. The shell needs a small session/provider layer to own it.
- There is **no `ThreadConfig` update path** on the engine. `ChatEngine` exposes only
  `sendTurn/editMessage/rerun/undo/cancel` (`engine.ts:45-51`). A config panel must either
  call `useChatStore.setThread({ ...thread, config })` then `saveThread(next)`
  (`chat/persistence.ts:69-76`), or the plan must add an engine method. `persist()` is private
  (`engine.ts:217-232`), so direct persistence is the smaller change.

## 5. Test strategy: what is actually configured

**Scripts** (`package.json:6-15`): `test` = `vitest run`, `test:watch` = `vitest`,
`lint` = `eslint .`, `build` = `tsc -b && vite build`, with `predev`/`prebuild` copying
Pyodide (`scripts/copy-pyodide.mjs`).

**Vitest config is a separate file** (`vitest.config.ts:1-10`), not inline in
`vite.config.ts`: `globals: true`, `environment: 'node'`, `setupFiles: ['./src/test-setup.ts']`,
`include: ['src/**/*.test.{ts,tsx}']`. `src/test-setup.ts:1` is exactly
`import 'fake-indexeddb/auto'` — there is no DOM setup.

**DOM/component testing is not configured.** `package.json` has no `jsdom`, no `happy-dom`,
and no `@testing-library/*`; the Vitest lockfile entries for `jsdom`/`happy-dom`/browser
providers are optional peer dependencies of Vitest, not installed packages
(`pnpm-lock.yaml:2685-2715`). The only `.test.tsx` in the repo is
`src/ai/secret-field.test.tsx`, and it uses `renderToStaticMarkup` from `react-dom/server`
(`:2,9,18`) to assert on the returned HTML string (`:10-15`). No test uses `render`,
`fireEvent`, `user-event`, `react-dom/client`, or `react-dom/test-utils` (grep found only
`main.tsx:2` `createRoot` and the vendored `image.tsx:11` `createPortal`).

**Typechecking of tests**: `tsconfig.app.json` includes `"src"` (`tsconfig.app.json:30`) and
sets `types: ["vite/client", "vitest/globals"]` (`:7`), so `pnpm build`'s `tsc -b` typechecks
test files along with app code. Consequences: new test files must compile under
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`
(`tsconfig.app.json:25-28`). `tsconfig.node.json` typechecks `vite.config.ts` and
`vitest.config.ts` only.

**What a new UI plan can test mechanically (node env)**:

- Pure state/logic: reducers, selectors, store actions, registry behavior, serializers,
  validators, config validators. Precedent: `chat/reducer.test.ts`,
  `chat/store.test.ts`, `tools/registry.test.ts`, `skills/registry.test.ts`,
  `vault/store.test.ts`.
- Encrypted persistence and lock races with `fake-indexeddb` and injected stores
  (`skills/registry.test.ts:109-175`, `vault/store.test.ts`). Keys are installed directly via
  `keyring.install(await deriveKey(...))` (`skills/registry.test.ts:111-113`).
- Server-render smoke of **pure presentational** components: `renderToStaticMarkup` works for
  stateless/hook-free components (SecretField test) and can assert structure, ARIA, and that
  secrets are not emitted. It cannot exercise state, effects, event handlers, portals, or
  refs.
- Canvas-free worker lifecycle via injectable `WorkerFactory`
  (`sandbox/js-runner.ts:37-43,26-30`; tests in `js-runner.test.ts`, `py-runner.test.ts`).
- `class`/`cn` output is not meaningfully assertable without a DOM/CSS engine; assert behavior,
  not Tailwind classes.

**What needs a browser gate (cannot be unit-tested here)**: the assistant-ui runtime bridge
(`useExternalStoreRuntime` + `AssistantRuntimeProvider` requires DOM and provider context),
composer send/cancel and scroll behavior, right-rail expand/collapse interactions and focus
management, `showDirectoryPicker` and permission re-grant (already deferred in the engine plan,
`plans/README.md:22-31`), real provider turns, worker/Pyodide execution, and any portal-based
overlay. The engine plan's precedent is to record these in a named journal artifact rather
than claim automated coverage (`plans/260919-0828-core-chat-engine/plan.md:195-201`) — the UI
plan should do the same.

**Exact commands and gates**: `pnpm test`, `pnpm lint`, `pnpm build` (which typechecks tests
through `tsc -b`). The plan's acceptance should keep all three green
(`brainstorm-…:40-41`) and must not encode a test count (explicit instruction in
`260919-0828-core-chat-engine/plan.md:184-185`).

## 6. Reusability: exact APIs per panel and what is missing

The block below is the key deliverable for the plan. Every "existing API" is exported and
usable today unless marked missing. **Critical preamble**: none of these are instantiated in
app code — the plan must add a composition layer (a session/`AssistantRuntimeProvider` seam)
that constructs one `SkillRegistry`, one `ToolRegistry`, the runners, the workspace handle,
and one `ChatEngine` per thread, then passes them down.

| Panel / feature | Existing exported API (file:line) | What the UI must supply | Gap / missing piece |
| --- | --- | --- | --- |
| Runtime bridge (center) | `createEngine(deps)` `chat/engine.ts:322`; `ChatEngine` methods `:45-51`; `useChatStore` `chat/store.ts:20` | `EngineDeps`: `getSettings`, `skillRegistry`, `toolRegistry`, `threadStore`, optional `workspace`/`codeRunner`/`modelFactory` (`engine.ts:25-43`) | No app instantiation; `useExternalStoreRuntime`/`AssistantRuntimeProvider` never used in `src` (grep). No config-update method. |
| Conversation list (left) | `listThreads()` `chat/persistence.ts:90-93`; `loadThread` `:84-88`; `deleteThread` `:95-100`; `saveThread` `:69-76`; `createThread` `:78-82`; `useChatStore.setActiveThread` `chat/store.ts:41-43` | Grouping key + title; create/rename/delete handlers | `ThreadSummary` is `{ id, updatedAt }` only (`persistence.ts:10-13`) — **no title, no workspace**. `ChatThread.title` exists (`types.ts:28`) but must be loaded per row or snapshotted. No workspace label field at all. |
| Workspace picker | `isPickerAvailable` `workspace/handle.ts:8-10`; `pickWorkspace` `:12-18`; `restoreWorkspace` `:20-24`; `clearWorkspaceHandle` `:26-28`; `ensurePermission` `workspace/fs.ts:57-71` | A live `WorkspaceFs` holder + denied-re-grant state | No in-app store for the current `WorkspaceFs`; single persisted handle id `'workspace'` (`db.ts:41-44`, `handle.ts:6`). |
| Workspace browser | `WorkspaceFs.list` `workspace/fs.ts:129-145`; `stat` `:192-208` | Recursive tree assembly (list is one level, sorted), lazy expansion | No recursive/tree helper, no change watcher. |
| File viewer/editor | `WorkspaceFs.readFile` `fs.ts:147-155`; `writeFile` `:157-172`; `DEFAULT_SIZE_CAP = 2 MB` `:24`; errors `workspace/errors.ts:8-41` | Dirty tracking, save/cancel, error mapping (`WorkspaceLimitError`, `WorkspacePermissionError`, `WorkspacePathError`) | No editor component; no dirty-state helper. Brainstorm chose plain textarea (`brainstorm-…:211-216`). |
| Chat config (Thread tab) | `defaultThreadConfig(providerId, modelId?)` `chat/types.ts:38-47`; `validateThreadConfig` `:100-159`; `DEFAULT_MAX_STEPS = 6`, `MIN_MAX_STEPS = 4` `:35-36`; `ChatConfigError` `chat/errors.ts` | Form state + field errors; provider/model pickers | No config update path on the engine; no global default provider in `Settings` (`settings.ts:30-37`). |
| Chat config (Providers tab) | `ProvidersPanel` `settings/ProvidersPanel.tsx:280`; `ModelManager` `ai/model-manager.tsx:22`; `SecretField` `ai/secret-field.tsx:13`; `validateProvider`/`resolveProvider` `ai/providers.ts:26,44`; `createLLM` `ai/llm.ts:8-21` | Mount in a tab; pass `draft`/callbacks for `ModelManager` | None — reusable as-is (`ProvidersPanel.tsx:162-168` shows the `ModelManager` prop wiring). |
| Chat config (Vault tab) | `StorageWarning` `settings/StorageWarning.tsx:6`; `DataEgressNotice` `settings/DataEgressNotice.tsx:4`; idle lock `vault/use-idle-lock.ts:5` | Mount in a tab; optionally expose idle-lock minutes editor | No idle-lock minutes field UI exists. |
| Skills panel | `SkillRegistry` `skills/registry.ts:17` — `list` `:39`, `get` `:35`, `setEnabled` `:47-51`, `resolve` `:53`, `importSkill` `:98-104`, `updateSkill` `:106-114`, `removeSkill` `:116-121`, `loadWorkspaceSkills` `:123-129`, `hydrate` `:131-135`; `skillStore` `skills/store.ts:60-64`; `parseSkillMarkdown` `skills/parser.ts:29`; `createWorkspaceSkillSource` `skills/workspace-source.ts:47`; `WORKSPACE_SKILLS_ROOT` `:8` | Import/edit/remove UI; enable toggles; workspace listing needs the `WorkspaceFs` passed as `WorkspaceApi` | **Enablement is in-memory only** (`registry.ts:47-51`) and `hydrate` re-enables **all** vault skills (`:131-135`). `SkillManifest` has no `enabled` field (`schema.ts:3-11`), so enablement has no persistence story. |
| Tools panel | `ToolRegistry` `tools/registry.ts:30` — `hydrate` `:39-41`, `registerProvider` `:43-51`, `registerUserTool` `:53-63`, `setEnabled` `:65-69`, `list` `:71-73`, `availableNames` `:75-84`, `buildToolSet` `:86-103`; `toolStore` `tools/store.ts:114-118`; `workspaceToolProvider` `tools/builtin/workspace.ts:23`; `createCodeToolProvider` `tools/builtin/code.ts:29`; validators `tools/types.ts:114,124,149` | Provider registration + UI for create/edit/delete; on toggle, call `setEnabled` **and** `toolStore.save` | **`setEnabled` does not persist** (`registry.ts:65-69`). The `enabled` flag lives on the definition (`types.ts:35,53`), so persistence requires saving the full definition after toggling; `hydrate` re-reads it (`registry.ts:39-41`). No app-side registry instance. |
| Sandbox panel | `JsRunner` `sandbox/js-runner.ts:20`, `defaultJsWorkerFactory` `:11`, `DEFAULT_JS_TIMEOUT_MS = 10_000` `:9`; `PyRunner` `sandbox/py-runner.ts:29`, `defaultPyWorkerFactory` `:11`, `DEFAULT_PY_TIMEOUT_MS = 30_000` `:9`; `CodeRunner.run` → `RunResult` `sandbox/types.ts:5-14`; `truncateOutput` (64 KB) `sandbox/protocol.ts:136-142` | Scratchpad source/result UI; enablement + timeout settings | **No factory that builds runners from `Settings`**, no persisted config, and no status/last-run API. `Settings` has no sandbox slice (`settings.ts:30-37`). |
| Workspace file bridge for tools | `WorkspaceApi` interface `tools/types.ts:19-26`; `attachFsHandler` `sandbox/fs-bridge.ts:25-55` | Pass the same `WorkspaceFs` as `deps.workspace` and `ports.workspace` | Single handle; no per-thread workspace. |

**Missing persisted-settings slices summary**: add a default provider (or choose first) and a
sandbox config slice to `Settings`; add skill-enablement persistence (or accept
re-enable-all-on-unlock and document it); pair tool toggles with `toolStore.save`; add a
`ThreadSummary` extension (title + workspace label) or load threads eagerly for the list.

## Constraints and conventions checklist

- [ ] **Brownfield style split honored.** New app-style files (`src/chat/*`, `src/ui/*`):
      2-space, single quotes, no semicolons, relative imports. New files under
      `src/components/**`: double quotes, semicolons, `@/` aliases, `"use client"` where the
      vendored pattern uses it. No formatter/prettier config exists, so match by file area.
- [ ] **Type-only imports use `import type`** (`verbatimModuleSyntax`, `tsconfig.app.json:19`).
- [ ] **No enums/namespaces/parameter properties** (`erasableSyntaxOnly`, `tsconfig.app.json:27`).
- [ ] **No unused locals/params** (tsconfig `:25-26` + typescript-eslint recommended,
      `eslint.config.js:12-17`).
- [ ] **`react-hooks` and `react-refresh` rules apply to all new app files**; only
      `src/components/**` gets the relaxations (`eslint.config.js:15-16,22-33`). Do not add
      `eslint-disable` comments to app code; none exist today.
- [ ] **React Compiler safe** (`vite.config.ts:63`).
- [ ] **Reuse tokens, never raw values**: colors/radius/easing/type from `src/index.css`;
      `panel-in` for panel motion; global `:focus-visible`; `min-h-11` touch target for shell
      chrome and panels.
- [ ] **Do not use shadcn `bg-accent` / `text-accent-foreground` / `bg-muted`** in new code;
      use `accent-soft` / `paper-sunk` / `text-muted` (`index.css:62-66`).
- [ ] **No second streaming/persistence path**: the UI must drive `createEngine` and the
      stores, never duplicate `engine.ts`/`reducer.ts`/`persistence.ts`
      (`brainstorm-…:32-33`).
- [ ] **Never render secrets**: `SecretField` is the only sanctioned key display
      (`secret-field.tsx:13-30`); the engine redacts error text (`engine.ts:58-68,261`).
- [ ] **Vault lock coordination**: do not re-implement abort/clear; rely on
      `chat/store.ts:71-76` and `registerAbortAll` (`:60-65`), and ensure the thread UI
      reacts to `activeThreadId === null`.
- [ ] **No new required `Settings` field that breaks migration**; additive fields are safe via
      `deepMerge` (`settings.ts:76-91`). If `SETTINGS_VERSION` must bump, update `migrate`
      (`:93-106`) and `defaultSettings` (`:44-60`).
- [ ] **Tests**: keep `pnpm test`, `pnpm lint`, `pnpm build` green; do not assert test counts;
      do not claim DOM/interaction coverage in node env. Put browser-only checks in a named
      journal artifact.
- [ ] **Plan authoring conventions** (`plans/260919-0828-core-chat-engine/plan.md`): frontmatter
      with title/status/priority/effort/tags/created; Overview, Goals table, Contract, Phases
      table, Dependencies, Success Criteria checkboxes, Risk summary; phase files with Goal,
      Context, Requirements, Architecture, Files to Create/Modify, Implementation Steps, Todo,
      Verification, Success Criteria, Risk Assessment, Security Considerations, Next Steps.
      Update `plans/README.md` index.
- [ ] **Worktree hygiene**: the working tree is dirty with in-progress UI work. Modified
      tracked: `eslint.config.js`, `skills-lock.json`, `src/App.tsx`, `src/main.tsx`,
      `src/index.css`, `src/ai/secret-field.tsx`, `src/settings/ProvidersPanel.tsx`,
      `src/settings/DataEgressNotice.tsx`, `src/vault/UnlockScreen.tsx`,
      `src/vault/RecoveryScreen.tsx`, `src/vault/ErrorBoundary.tsx`, `tsconfig.app.json`,
      `tsconfig.json`. Untracked: `src/components/`, `src/ui/`, `src/hooks/`, `src/lib/`,
      `src/settings/StorageWarning.tsx`, `src/ai/model-manager.tsx`, `src/ai/model-catalog.ts`,
      `components.json`, `.agents/skills/*`, `plans/…`. Last commit is the engine
      (`e331a78`). New shell files must use **new names** and must not overwrite or restructure
      the untracked UI files; coordinate before editing `App.tsx`/`index.css`/`main.tsx`.
- [ ] **No repo-local AGENTS.md** (see UNVERIFIED). The global operator rules apply but are not
      checked into this repo.

## UNVERIFIED / open questions

1. **No root `AGENTS.md`.** A recursive search found none outside `node_modules`. The
   instructions the session receives come from a global operator config, not the repository.
   If the plan intends to cite repo-local agent rules, none exist to cite.
2. **No visual/class-level test harness.** Whether the team wants to add `jsdom` +
   `@testing-library/react` or Vitest browser mode for the shell is a plan decision. Current
   evidence is that the suite is deliberately node-only with a single server-render smoke test,
   so adding a DOM environment is a new capability, not a reuse.
3. **Whether the shell stays inside `max-w-5xl`.** The current container (`App.tsx:23,42`)
   cannot host a left rail plus a right rail plus a 44rem center without crowding. The plan
   must state the shell width model and responsive collapse (brainstorm unresolved question 4,
   `brainstorm-…:245-246`).
4. **Default provider for new threads.** No global default exists (`settings.ts:30-37`); the
   plan must pick "first provider" or add a settings field (brainstorm question 5).
5. **Skill enablement persistence.** No `enabled` field exists on `SkillManifest`
   (`schema.ts:3-11`) and `hydrate` re-enables all vault skills (`registry.ts:131-135`).
   Whether to add a persisted enablement map or accept the reset is a scope decision.
6. **`ThreadSummary` extension vs eager load.** Title and workspace are not in the summary
   (`persistence.ts:10-13`); the plan must choose between extending the summary/envelope and
   loading each thread for the list.
7. **Editor depth.** Plain textarea per the brainstorm (`brainstorm-…:211-216`); no editor
   dependency is installed. If CodeMirror/Monaco is wanted, that is new scope.
8. **Scratchpad workspace access.** Whether the sandbox console gets the `WorkspaceApi` bridge
   or runs file-less is unresolved (`brainstorm-…:242-243`).
9. **`cn` adoption.** New `src/components/**` files can use `cn` (`lib/utils.ts:5-7`), but
   house `src/ui/*` code does not; mixing the two in one component family is a consistency
   risk the plan should decide on.
