---
phase: 2
title: "Bridge server, authentication, and deeplink pairing"
status: completed
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 2: Bridge server, authentication, and deeplink pairing

## Goal
Build the CLI. It serves `GET /health`, a one-time `GET /pair` deeplink that opens the app already paired, and an authenticated WebSocket on `127.0.0.1`. A socket is rejected before any session exists unless its Host, Origin and token all pass.

## Key Insights
- Any web page can open `ws://127.0.0.1:PORT`, and DNS rebinding gets past a loopback bind. Host and Origin must each be checked against a fixed allowlist ([security report](../reports/researcher-260929-1643-pty-bridge-security.md) §1).
- A browser cannot set WebSocket headers. The token therefore travels as the `sagent-token.<token>` subprotocol, and the server echoes only `sagent-bridge.v1`.
- **Token in memory only, new each start (user, 2026-09-29).** A persisted token file is readable by any command the model runs, and a same-origin worker could replay the token. <!-- Red Team: token exfiltration -->
- **Deeplink (user, 2026-09-29).** The bridge prints a link and opens a browser tab. The user unlocks the vault and the app connects. Argv (for `open` or `xdg-open`) is visible in `ps`, so the link carries only a one-time code. The bridge's `/pair` redirect puts the token into a URL fragment, which is never sent to a server.

## Files to Create / Modify
- Create: `packages/sagent-bridge/src/cli.ts`. It parses args, refuses win32, prints the banner and link, opens the browser, lets Enter mint a new link, and handles signals.
- Create: `packages/sagent-bridge/src/config.ts`. It resolves options, the root, the token and the origins.
- Create: `packages/sagent-bridge/src/pair.ts`. It holds one-time pair codes and the redirect.
- Create: `packages/sagent-bridge/src/open-browser.ts`. It spawns `open` on darwin or `xdg-open` on linux, with an argv array and no shell.
- Create: `packages/sagent-bridge/src/server.ts`. It runs the HTTP server, the upgrade guard and the client registry.
- Create: `packages/sagent-bridge/src/auth.ts`. It checks Host and Origin and compares the token in constant time.
- Create: tests `config.test.ts`, `auth.test.ts`, `pair.test.ts`, `server.test.ts`.

## CLI
- Usage: `sagent-bridge --root <dir> [--port 7717] [--app-url http://localhost:5173] [--origin <url>]... [--no-open] [--allow-broad-root]`.
- `--root` is required. The bridge stores its `fs.realpath` and exits if the path is missing or is not a directory.
  - It refuses `/`, `$HOME` and any ancestor of `$HOME` unless `--allow-broad-root` is passed. Otherwise every "outside the root" rule would be meaningless. <!-- Red Team: broad root -->
- The allowed origins are the `--app-url` origin, the loopback twin of that origin (`localhost` ↔ `127.0.0.1`), and each `--origin`, matched exactly. Wildcards are rejected.
- The token is 32 random bytes in base64url, generated at start and held in memory only.
  - `SAGENT_BRIDGE_TOKEN` in the environment overrides it, for automation and tests. The README says this token then lives in that environment.
  - The bridge never accepts the token on argv.
- On `process.platform === 'win32'`, the bridge exits 1 with "sagent-bridge supports macOS and Linux".
- The banner prints version, root, port and origins, then `Pair: http://127.0.0.1:<port>/pair?code=<code>`. The token itself is never printed.
- Unless `--no-open` is passed, the bridge opens that pair URL in the default browser.
- When stdin is a TTY, pressing Enter mints a new code, prints it and opens it.
- On SIGINT or SIGTERM, the bridge kills all sessions (phase 3), closes the sockets and exits 0.

## Pair endpoint
- Codes are 16 random bytes in base64url. Each is single use and expires after 10 minutes. At most 5 are live at a time; minting another drops the oldest.
- A valid `GET /pair?code=<code>` consumes the code and returns 302 to `<app-url>/#sagent-bridge=<encoded ws://127.0.0.1:<port>>&token=<token>`.
  - Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- An unknown, used or expired code returns 410 with a plain page: "Link expired. Press Enter in the sagent-bridge terminal for a new one."
- The Host check applies here too. The Origin check does not, because this is a top-level navigation.

## Server
- The server binds only to `127.0.0.1`. If the port is taken, it exits with a message that names the port. It never tries another port. Port `0` is accepted for tests, and the banner prints the actual port.
- `GET /health`:
  - Allowed origins get `{ name, protocol, bridgeVersion, rootName, allowed: true }` with CORS headers for that origin.
  - Any other origin gets `{ name, protocol, allowed: false }` with `Access-Control-Allow-Origin: *`. The app can then tell "origin not allowed" apart from "unreachable". The answer contains no path or folder name. <!-- Red Team: diagnosis -->
- The upgrade guard runs in this order. Each failure destroys the socket with 401 or 403:
  1. Host is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`.
  2. Origin is in the allowlist. A missing Origin is rejected; there is no test-mode exception.
  3. The subprotocol list contains `sagent-bridge.v1` and exactly one `sagent-token.*` entry whose token matches. The comparison uses `crypto.timingSafeEqual` on equal-length buffers.
- `WebSocketServer` runs with `maxPayload: 1 MiB` and `perMessageDeflate: false`.
- The server sends `hello` right after a connection opens. The client's `hello` must arrive within 5 s, or the server closes with 4001.
- Heartbeat: the server pings every 30 s and terminates a socket that has not answered by the next tick. Sessions do not depend on sockets.
- A malformed frame gets `error { code: 'bad_request' }`.
- Dropped as unrequested: rate limiting, a client cap, and closing on repeated malformed frames. <!-- Red Team: scope trims -->

## Tasks & Steps
1. `config.ts`. Tests cover the broad-root refusal (including `$HOME`), origin derivation from `--app-url`, and the token source.
2. `auth.ts` as pure functions. Tests cover a Host of `evil.com`, `127.0.0.1.evil.com`, Origin `null`, a different port, a length mismatch and a duplicated token.
3. `pair.ts`. Tests cover single use, expiry (with fake timers), the 5-code cap, the redirect `Location` format, and no-store headers.
4. `server.ts` with `ws` in `noServer` mode behind `http.createServer`.
5. `cli.ts` and `open-browser.ts`. A unit test checks that the spawn argv contains only the pair URL.
6. `server.test.ts` against a real server on port 0. It uses the `ws` client with an explicit `origin`, and `fetch` for `/health` and `/pair` with `redirect: 'manual'`.

## Verification
- `pnpm bridge:test` covers:
  - a correct Host, Origin and token connecting and receiving `hello`
  - a wrong token rejected with 401
  - a rebinding Host rejected with 403
  - a foreign or missing Origin rejected with 403
  - `/health` returning `allowed: false` for a foreign origin
  - `/pair` redirecting once and then returning 410
- Manual:
  - `node packages/sagent-bridge/dist/cli.js --root .` opens a tab at the app with the fragment.
  - `lsof -i :7717` shows the bridge listening on 127.0.0.1 only.
  - `ps -o args=` for the `open` child shows no token.

## Security Considerations
- The token appears only in the 302 `Location` header and in memory. Error messages redact it.
- Anyone who can get the `/pair` URL within 10 minutes and before first use can pair with the bridge. The code sits in the terminal scrollback and briefly in `ps`, which is the same trust boundary as the user's shell.
