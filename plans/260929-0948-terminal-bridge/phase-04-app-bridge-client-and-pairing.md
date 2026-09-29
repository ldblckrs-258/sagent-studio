---
phase: 4
title: "App bridge client, deeplink pairing, and root binding"
status: completed
priority: P1
effort: "9h"
dependencies: [1, 2]
---

# Phase 4: App bridge client, deeplink pairing, and root binding

## Goal
Add a bridge connection to the app. It pairs automatically from the deeplink as soon as the vault is unlocked, keeps the token in the encrypted Settings blob, and connects after unlock. It proves the bridge root is the folder of the calling thread, and it exposes a `TerminalPort`. The token must stay out of reach of workers and same-origin previews.

## Key Insights
- **Lifecycle.** `session.startMcp()` is called from `src/session/session-provider.tsx:63` after unlock, and `session.dispose()` runs on lock and on unmount (`session-provider.tsx:91`, `src/session/session.ts:598-618`). The terminal manager should follow the same lifecycle.
- **Where secrets live.** Secrets already sit in the encrypted `Settings` object: provider `apiKey` at `src/vault/settings.ts:33` and TypeSafe at `:39`, persisted via `src/vault/store.ts:189`. One `{ url, token }` record belongs there. A new Dexie table would need both wipe lists (`src/vault/store.ts:340-366`, `:393-405`) and would break `src/mcp/store.test.ts:187`. <!-- Red Team: persistence -->
- **Workspace handles.**
  - Handles are stored under slot ids (`src/workspace/handle.ts:6,13-15`), and `pickWorkspace` overwrites a slot in place (`:35-39`).
  - `sameDirectory` already exists (`:17-29`).
  - The live `fs` is global (`src/session/workspace-state.ts:17`), and sub-agent ports use it (`src/session/session.ts:528`).
  - Binding must therefore resolve the thread's own handle, cache on the handle object with `isSameEntry`, and be single-flight. <!-- Red Team: root binding -->
- **Same-origin code.** Two contexts can currently reach the app's socket or token:
  - The sandbox worker has page-equivalent network access (`vite.config.ts:22-28`), and nothing shadows `WebSocket` there (`src/sandbox/*` has no match).
  - Workspace HTML previews run same-origin: `PREVIEW_SANDBOX` has `allow-same-origin` and uses `srcdoc` (`src/ui/file-view/sandbox.ts:1-10`, `html-view.tsx:35,80`).
  - Both have to be closed before the bridge ships. <!-- Red Team: token replay, preview hijack -->
- **Node test client.** Node 24's global WebSocket (undici) sends no `Origin`. Tests therefore inject a `ws` client constructed with `{ origin }`. <!-- Red Team: test infra -->

## Files to Create / Modify
- Create: `src/terminal/types.ts` with `TerminalPort`, `BridgeStatus` and `BridgeConfig`.
- Modify: `src/vault/settings.ts`. Add `terminal?: { url: string; token: string }` to `Settings`, plus `validateTerminalSettings()` following `validateContextSettings` (`:247`). Default is absent.
- Create: `src/terminal/pairing.ts`. It captures, validates and strips the fragment, and holds the pending pair in memory.
- Create: `src/terminal/client.ts`. The WebSocket client, with an injectable `WebSocket` constructor, request correlation, a 5 s request timeout, reconnect, and output subscriptions.
- Create: `src/terminal/root-binding.ts`. `ensureBound(threadId)`: single-flight per thread, unique probe file per nonce, cached per connection epoch and handle object.
- Create: `src/terminal/manager.ts`. Owns the client, status, the session list, `revive()` and `dispose()`, the token (memory only), and a `redact(text)` helper.
- Modify: `src/tools/types.ts:322-340`. Add `terminal?: TerminalPort` to `ToolRuntimePorts`.
- Modify: `src/chat/engine.ts:137` (`EngineDeps`) and the ports built at `:456-476` to carry `terminal`.
- Modify: `src/session/session.ts`:
  - Create the manager.
  - Add `startTerminal()` next to `startMcp()` (`:395`).
  - Pass `terminal` in the agent ports (`:520-532`), in the engine deps getter (`:553-576`), and in `builtinProviders()` ports (`:691-706`).
  - Dispose the manager in `dispose()` (`:598-618`).
- Modify: `src/session/session-provider.tsx:63` to call `session.startTerminal()` after `startMcp()`.
- Modify: `src/main.tsx:35`. Call `capturePairingFragment(window)` before `createRoot`.
- Modify: `src/sandbox/js-worker.ts` and `src/sandbox/py-worker.ts`. Delete `WebSocket`, `EventSource` and `WebTransport` from `globalThis` before any user code runs.
- Modify: `src/ui/file-view/sandbox.ts` and `src/ui/file-view/html-view.tsx`. While a bridge is paired, workspace previews use the opaque sandbox (no `allow-same-origin`). With no pairing, nothing changes (user, 2026-09-29).
- Create: `src/terminal/test-utils/node-dir-handle.ts`. A `FileSystemDirectoryHandle` backed by `node:fs`, rooted at a temp dir. It implements the methods root binding uses: `getDirectoryHandle`, `getFileHandle`, `createWritable`, `removeEntry`, `isSameEntry`, `queryPermission`.
- Create: `src/terminal/test-utils/bridge-process.ts`. Spawns `node packages/sagent-bridge/dist/cli.js --root <tmp> --port 0 --no-open` with `SAGENT_BRIDGE_TOKEN` set, parses the port from the banner, and kills the process on teardown. A vitest `globalSetup` builds the bridge once.
- Create: tests `pairing.test.ts`, `client.test.ts`, `root-binding.test.ts`, `manager.test.ts`, plus worker tests that assert `typeof WebSocket === 'undefined'` inside the JS and Python sandboxes.

## Behavior
**Deeplink pairing (user, 2026-09-29).**
1. The bridge's `/pair` redirect opens `<app>/#sagent-bridge=<ws-url>&token=<t>`.
2. `capturePairingFragment` parses the fragment, removes it with `history.replaceState`, and keeps the pair in memory only.
3. After unlock, `startTerminal()` sees the pending pair, connects, and waits for the bridge `hello`. It shows no confirm dialog: unlocking the vault is the consent.
4. Only after `hello` succeeds is the pair written to `Settings.terminal`, replacing any older pairing. A crafted link with a bad token can never overwrite a working pairing. It fails and shows an error in the panel.
5. If the tab already holds an unlocked vault, the new tab still has to be unlocked, because each tab has its own vault key.

**URL rule.** The scheme must be `ws:` and the host exactly `127.0.0.1`, `localhost` or `[::1]`. Anything else is refused.

**Manual pairing.** The Terminal panel (phase 7) accepts a URL and a token, which is useful with `--no-open`.

**Connect.**
- `new WebSocket(url, ['sagent-bridge.v1', 'sagent-token.' + token])`.
- Check that `hello.protocol === PROTOCOL_VERSION`.
- Each `hello` starts a new connection epoch, and the root-binding cache is cleared.

**Status.** This mirrors MCP (`src/mcp/manager.ts:42`): `unpaired | connecting | ready | needs-auth | error`, with a `reason` string. <!-- Red Team: scope trims -->

**Reason hints.** They are chosen by probing:
1. `navigator.permissions.query({ name: 'loopback-network' })`, when the API supports it. `denied` gives the hint "Allow local network access for this site".
2. `GET /health`:
   - A network failure gives "Bridge not running: `npx sagent-bridge@<exact version> --root <folder>`".
   - `allowed: false` gives "Start the bridge with `--app-url <this origin>`".
   - An allowed response followed by a failed socket gives `needs-auth` with "Pairing expired — press Enter in the bridge terminal and open the new link".
   - A protocol mismatch gives "Update the bridge".

**Reconnect.**
- Exponential backoff of 1, 2, 4, 8 and 16 s, up to 10 attempts. The panel has a Retry button.
- Lock stops reconnecting.
- A restarted bridge has a new token, so the stored pairing gets `needs-auth` until a new link is opened.

**Root binding (`ensureBound(threadId)`).**
1. Resolve the thread's handle through `threadHandleId(threadId)`, falling back to the global slot the same way `workspace-state` does. Sub-agents pass their parent `threadId`.
2. If the cache holds the same epoch and `isSameEntry(cached, handle)`, return the cached result.
3. Otherwise, in a single flight per thread:
   - Check `queryPermission({ mode: 'readwrite' })`. Anything other than `granted` returns `permission_denied` with "Grant write access in the Workspace panel". A tool call cannot request permission because it has no user gesture.
   - Write `.sagent/bridge-probe-<nonce>` through the raw handle, bypassing the journal.
   - Send `verifyRoot`. The bridge deletes the file.
   - Cache `{ epoch, handle, matches }`.
4. A mismatch returns `root_mismatch` without caching, so the next call probes again.

**TerminalPort.** `status()`, `onChange(listener)`, `sessions()`, `ensureBound(threadId)`, `create`, `input`, `resize`, `read`, `kill`, `killOwned`, `list`, `classify`, `classifyInput`, `subscribe(sessionId, onOutput, sinceOffset)`, `redact(text)`. The token is never a field of the port.

## Tasks & Steps
1. The Settings field and validator. Tests: a round trip, invalid shapes dropped.
2. `pairing.ts`. Tests:
   - a valid fragment is captured and stripped
   - remote hosts, `wss:` and `http:` are refused
   - the pending pair is cleared after use
   - a bad token leaves an existing pairing intact
3. `client.ts` against the real bridge process. Tests: hello, protocol mismatch, correlation of out-of-order replies, request timeout, reconnect after a restart, and a new epoch.
4. `root-binding.ts` with `node-dir-handle` and a real bridge on the same temp dir. Tests:
   - match
   - mismatch (a different dir)
   - two parallel `ensureBound` calls give one probe
   - a re-pick to another dir drops the cache
   - `prompt` permission gives `permission_denied`
   - the probe file is gone afterwards
5. The worker global removal and the preview sandbox switch, with tests.
6. Wire the manager into `session.ts` and `session-provider.tsx`, then run `pnpm test`.

## Verification
- `pnpm test` is green, including the real-bridge suites.
- Manual:
  1. Run `npx sagent-bridge --root .`.
  2. The tab opens. Unlock the vault. The panel shows `ready · root: sagent-studio`.
  3. Lock: the bridge logs the socket closing. Unlock: it reconnects.
  4. Restart the bridge: the panel shows `needs-auth`. Open the new link: it shows `ready`.

## Security Considerations
- The token lives in the encrypted Settings blob and in `manager` memory. It is never part of `ToolRuntimePorts`, tool results, thread messages, or logs.
- The engine-level assertion is in phase 8. `redact()` strips the token from any output before it reaches the model.
