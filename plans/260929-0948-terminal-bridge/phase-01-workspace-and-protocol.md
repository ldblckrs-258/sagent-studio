---
phase: 1
title: "Workspace and shared protocol"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Workspace and shared protocol

## Goal
Turn the repo into a pnpm workspace that contains a publishable `packages/sagent-bridge`, with one protocol module that both the bridge and the app import. Also open the production CSP to the loopback WebSocket.

## Key Insights
- Today the repo is a single package and has no `pnpm-workspace.yaml`. The root `vitest.config.ts:14` only includes `src/**`, and `tsconfig.app.json:33` only includes `src`, so the package stays out of the app build.
- The app imports only types and constants from the protocol file, through a Vite and tsconfig alias that points at the source file. Native code never enters the browser bundle, and app dev never needs a bridge build first.
- `connect-src` at `vite.config.ts:47` allows `http://localhost:*` and `http://127.0.0.1:*` but no `ws:` source. Under CSP3 an `http:` host-source does not match a `ws:` URL, so the production build would block the bridge socket. <!-- Red Team: CSP ws gap -->

## Files to Create / Modify
- Create: `pnpm-workspace.yaml` (`packages: ['packages/*']`).
- Create: `packages/sagent-bridge/package.json` with:
  - `name: sagent-bridge`, `version: 0.1.0`, `license: MIT`, `type: module`
  - `bin: { "sagent-bridge": "dist/cli.js" }`, `engines.node >=20`, `os: ["darwin", "linux"]`
  - `files: ["dist", "README.md", "LICENSE"]`, `exports` for `.` and `./protocol`
  - scripts: `build` (tsup), `test` (vitest), `typecheck` (tsc --noEmit)
  - every dependency pinned exactly, with no `^` and no `~`
- Create: `packages/sagent-bridge/LICENSE` (MIT, copyright Le Duc Bao 2026).
- Create: `packages/sagent-bridge/tsconfig.json` (NodeNext, strict, `types: ["node"]`).
- Create: `packages/sagent-bridge/tsup.config.ts`:
  - ESM, target node20, entries `src/cli.ts` and `src/protocol.ts`, shebang kept.
  - `onSuccess` copies `tree-sitter-bash.wasm` into `dist/`.
- Create: `packages/sagent-bridge/vitest.config.ts` (node env, `src/**/*.test.ts`).
- Create: `packages/sagent-bridge/src/protocol.ts` and `protocol.test.ts`.
- Modify: `vite.config.ts`:
  - Add the resolve alias `sagent-bridge/protocol` → `packages/sagent-bridge/src/protocol.ts`.
  - Add `ws://127.0.0.1:* ws://localhost:*` to `connect-src` (line 47).
- Modify: `tsconfig.app.json` `paths` and `vitest.config.ts` alias, using the same mapping.
- Modify: `eslint.config.js`. Add `packages/*/dist` to `globalIgnores`, and add a `packages/**` block with `globals.node`.
- Modify: root `package.json`:
  - scripts `bridge:test` and `bridge:build` (`pnpm --filter sagent-bridge <script>`).
  - devDependency `ws` pinned `8.22.0`. App tests use it as a WebSocket client that can send `Origin`.

## Protocol contents (`protocol.ts`)
- Constants: `PROTOCOL_VERSION = 1`, `SUBPROTOCOL = 'sagent-bridge.v1'`, `TOKEN_SUBPROTOCOL_PREFIX = 'sagent-token.'`, `DEFAULT_PORT = 7717`, `PAIR_FRAGMENT_KEY = 'sagent-bridge'`.
- Client-to-bridge messages, each correlated by `id`:
  - `hello { clientVersion }`
  - `create { kind: 'exec' | 'pty', command?, cwd?, cols?, rows?, timeoutMs?, shell: 'model' | 'user', owner }`
    - `owner` is `{ source: 'model' | 'user' | 'agent', threadId?, runId? }`.
  - `input { session, data }`, `resize { session, cols, rows }`
  - `read { session, sinceOffset?, maxBytes?, format: 'raw' | 'plain' }`. When `sinceOffset` is omitted, the bridge returns the tail.
  - `attach { session, sinceOffset? }`, `detach { session }`
  - `kill { session }`, `killOwned { threadId?, runId? }`, `list {}`
  - `classify { command }`
  - `classifyInput { session, input?, keys?, submit }`
  - `verifyRoot { nonce }`
- Bridge-to-client messages:
  - `hello { protocol, bridgeVersion, platform, rootName, rootFingerprint, capabilities: ('pty' | 'exec' | 'classify')[] }`
    - `rootFingerprint` is the sha256 hex of the root realpath.
  - `ok { id, result }`, `error { id?, code, message }`
  - `output { session, data, offset }`, `exit { session, exitCode, signal? }`
  - `sessions { sessions }`, pushed on every create or exit.
- `SessionInfo { id, kind, shell, command, cwd, owner, running, exitCode?, startedAt, nextOffset, cols?, rows? }`
  - `id` is a random UUID, so ids are never reused across bridge restarts.
- `Classification { sensitive, reasons: string[], commands: string[] }`
- Error codes: `unauthorized`, `bad_request`, `cwd_outside_root`, `session_not_found`, `session_limit`, `pty_unavailable`, `timeout`, `root_mismatch`.
- Type guards `isClientMessage` and `isBridgeMessage`, with hand-written validation.

## Tasks & Steps
1. Add the workspace file and the package skeleton. Run `pnpm install`, then `pnpm install --frozen-lockfile`.
2. Write `protocol.ts` and its guards. The tests cover a missing `type`, a wrong field type, an unknown `type`, and a non-UUID session id.
3. Add the aliases. `import type { SessionInfo } from 'sagent-bridge/protocol'` must type-check from `src/`.
4. Add the CSP sources and the lint config, then run `pnpm lint`.

## Verification
- `pnpm bridge:test` passes the guard tests.
- `pnpm test` and `pnpm lint` stay green, and `tsc -b` accepts the alias import.
- `pnpm --filter sagent-bridge pack --dry-run` lists only `dist/`, `README.md`, `LICENSE` and `package.json`.
- A `vite build` output (run only with the user's OK) has `ws://127.0.0.1:*` in the CSP meta.
