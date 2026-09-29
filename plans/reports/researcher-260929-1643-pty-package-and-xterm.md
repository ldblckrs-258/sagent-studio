# Research: sagent-bridge PTY package, protocol, and xterm frontend

Date: 2026-09-29. Versions checked with `npm view` on 2026-09-29. Claims marked (unverified) come from my prior knowledge, not a fetched source.

## Outcome (read this first)

1. PTY lib: use `@lydell/node-pty` (1.2.0-beta.15). It installs prebuilt binaries via optionalDependencies with no install script. This is the only option that survives `npx` on Linux under npm 12, which blocks dependency install scripts by default. `node-pty` 1.1.0 has no Linux prebuilds and needs a toolchain there.
2. Server: `ws` 8.22.0, JSON text frames, `bufferedAmount` watermarks that call `pty.pause()/resume()`, and 30s ping/pong.
3. Protocol: small JSON schema with a hello/version handshake, a byte-offset ring buffer per session, and reattach by `sinceOffset`. Output frames carry an offset.
4. One-shot commands: default to `child_process.spawn` without a PTY (clean stdout/stderr, real exit code). Use a PTY only when `tty: true`. In a persistent shell, delimit commands with OSC 633 or nonce markers.
5. Frontend: `@xterm/xterm` 6.0.0 plus `addon-fit` 0.11.0 and `addon-web-links` 0.12.0. Add `@xterm/headless` 6.0.0 + `addon-serialize` 0.14.0 on the bridge side only if the model needs screen snapshots.
6. Packaging: keep the app at the repo root, add `pnpm-workspace.yaml` with `packages/*`, and put `sagent-bridge` in `packages/sagent-bridge`. Export protocol types and `PROTOCOL_VERSION` from a `sagent-bridge/protocol` subpath. Do not create a third package.
7. Security is a hard requirement, not optional: check `Origin` and `Host`, and require a random token. See section 3.

## 1. PTY library

| Option | Version | Prebuilds | Build tools needed | Risk |
|---|---|---|---|---|
| `node-pty` (Microsoft) | 1.1.0 (latest, 2026-08-03); `beta` = 1.2.0-beta.15 | 1.1.0 tarball contains `prebuilds/` for darwin-arm64, darwin-x64, win32-x64, win32-arm64 only. No linux. | Linux: yes (make, python, g++) via `node-gyp rebuild` fallback. macOS/Windows: no. | npm 12 blocks its `install` script unless `allowScripts` lists it. |
| `@lydell/node-pty` | 1.2.0-beta.15 (`latest` tag is the beta) | darwin x64/arm64, linux x64/arm64, win32 x64/arm64, each as a separate optionalDependency package | None. It never calls node-gyp. | Single maintainer fork. Only beta versions are tagged latest. The maintainer says it may become unnecessary. |
| `@homebridge/node-pty-prebuilt-multiarch` | 0.14.1 (2026-09-01) | Yes, downloaded from GitHub releases at install | No, but the download step depends on the network | Install-time script and download; also blocked by npm 12 script policy. Older node-pty base. |
| `bun-pty` | 0.4.10 | Bun only | n/a | Forces Bun runtime; wrong for `npx` on Node 20. |
| `child_process` + `script` | builtin | n/a | none | No resize (no ioctl), quirky flags across BSD and GNU `script`, no Windows. Only a degraded fallback. |

Findings:
- Microsoft's 1.1.0 has `"install": "node scripts/prebuild.js || node-gyp rebuild"`. The tarball only has darwin and win32 prebuilds, so Linux always compiles. Verified by listing the tarball.
- npm 12 blocks lifecycle scripts unless allow-listed, and `npx` has no manifest to allow-list them. Real-world breakage is documented in [t3code issue 7847](https://github.com/pingdotgg/t3code/issues/7847). Pin the failure mode to Linux, with the error `Cannot find module './prebuilds/linux-x64//pty.node'`.
- The `@lydell` fork's own description: prebuilt-only, no node-gyp, under 1 MB on macOS/Linux, per-platform packages ([repo](https://github.com/lydell/node-pty)). Search results state its 1.2.0-beta.15 has Linux glibc >= 2.28 prebuilds; musl (Alpine) support is not confirmed.
- Package size: `node-pty` unpacked is about 64 MB (`npm view node-pty dist.unpackedSize`); the fork's wrapper is 13 KB plus one platform package.

Recommendation, ranked:
1. `@lydell/node-pty@1.2.0-beta.15`, pinned exactly. Same API as node-pty (`spawn`, `onData`, `onExit`, `resize`, `pause`, `resume`, `kill`).
2. `node-pty@1.1.0` only if you accept a documented Linux prerequisite. Not suitable for `npx`.
3. Keep the PTY behind a 30-line adapter (`spawnPty()`), so switching to Microsoft's package once its Linux prebuilds ship is a one-line change.

Adoption risk: fork is beta and single-maintainer. Mitigation is the adapter plus exact pin. On load failure, print a clear error naming the platform and fall back to no-PTY mode (section 4), which still covers one-shot commands.

## 2. WebSocket server (`ws` 8.22.0)

Sources: [ws API doc](https://github.com/websockets/ws/blob/master/doc/ws.md), [ws README](https://github.com/websockets/ws).
- Version 8.22.0 (2026-09-26), Node >= 10, zero required deps. `bufferutil` and `utf-8-validate` are optional peers; skip them, since throughput is small.
- Server-side `perMessageDeflate` defaults off. Keep it off: on loopback it only costs CPU.
- Default `maxPayload` is 100 MiB. Set `maxPayload: 1 << 20` (1 MiB) because inputs are keystrokes and pastes.
- v8 delivers `message` as `(data, isBinary)`. Text frames arrive as a Buffer, so branch on `isBinary` and call `data.toString()` for JSON.
- Backpressure: `ws.bufferedAmount` counts queued bytes. Recommended pattern:
  - on each `pty.onData`, `ws.send(frame)`; if `ws.bufferedAmount > 1 MiB`, call `pty.pause()`.
  - poll every 50 ms, or use the `send` callback, and call `pty.resume()` when `bufferedAmount < 256 KiB`.
  - Also always append to the ring buffer regardless of socket state, so slow clients never lose data; they just replay.
- Heartbeat: server pings every 30s, marks `isAlive=false`, terminates the socket if no pong by the next tick (the pattern in the ws README). Sessions must NOT die with the socket; that is what makes reattach work. Add an idle-reap timer (for example, 30 min with no clients and a finished process).
- Text vs binary: JSON text frames for everything in v1. The PTY stream is UTF-8 text and node-pty's default string decoding handles split multi-byte sequences. Binary frames only pay off for raw high-throughput streaming; ttyd does this, but it is an optimisation you do not need (see section 3).

## 3. Protocol design

Reference schemas:
- ttyd: one-byte command prefix on binary/text frames. Client to server: INPUT, RESIZE_TERMINAL (JSON cols/rows), PAUSE, RESUME, JSON_DATA (initial auth + size). Server to client: OUTPUT, SET_WINDOW_TITLE, SET_PREFERENCES. Source: [ttyd protocol.c](https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c). Numeric byte values not confirmed from the fetch; PAUSE/RESUME is client-driven flow control.
- terminado (Jupyter): JSON arrays like `["stdin", data]`, `["set_size", rows, cols, h, w]`, `["stdout", data]`, `["setup", {}]`, `["disconnect", 1]` (unverified against source; the [repo README](https://github.com/jupyter/terminado) does not document it). It keeps a scrollback buffer and replays it on new connections.
- VS Code: not a wire protocol, but its terminal process host has explicit `createProcess`, `input`, `resize`, `shutdown`, and reconnect with replay events. Its shell integration uses OSC 633 A/B/C/D/E/P ([docs](https://code.visualstudio.com/docs/terminal/shell-integration)).
- gotty and wetty: same shape as ttyd (prefix byte or small JSON, plus resize) (unverified).

Common lessons: keep input, output, resize, exit as top-level types; give sessions server-owned IDs; replay is server-side ring buffer. None of them offers offset-based reads; that is the addition you need for model tools.

Recommended minimal schema (JSON text frames, one `type` field, request/response correlated by `id`):

```
client -> bridge
 hello    { type, protocol: 1, token, clientVersion }
 create   { type, id, mode: "shell" | "command", command?, args?, cwd?, env?, cols, rows, tty?: boolean }
 input    { type, session, data }
 resize   { type, session, cols, rows }
 read     { type, id, session, sinceOffset, maxBytes? }      // snapshot of buffered output
 attach   { type, id, session, sinceOffset? }                // subscribe + replay
 detach   { type, session }
 kill     { type, id, session, signal? }
 list     { type, id }
bridge -> client
 hello    { type, protocol, bridgeVersion, capabilities: ["pty","exec"], platform }
 ok       { type, id, ...result }   // create: { session }, list: { sessions: [...] }, read: { data, fromOffset, nextOffset, truncated }
 error    { type, id?, code, message }
 output   { type, session, data, offset }     // offset = byte offset of the START of data; next = offset + byteLength
 exit     { type, session, exitCode, signal? }
```

Design rules:
- Offsets are absolute byte counts since session start. The ring buffer (for example, 1 MiB) drops old bytes; if `sinceOffset` is older than the buffer start, reply `truncated: true` with `fromOffset` set to the earliest retained byte. That single rule gives reattach-after-reload (`attach` with the last seen offset, or 0 for a full replay) and model-side "read since last read".
- Store `exitCode` and the final buffer after exit until reaped, so a late `read` still works.
- `list` returns `{ id, mode, command, cwd, cols, rows, running, exitCode?, startedAt, nextOffset }`; the UI stores the last session id in `sessionStorage` to reattach.
- Handshake and compatibility: bridge sends `hello` with integer `protocol` first. Client refuses on mismatch and shows "run `npx sagent-bridge@latest`". Bump `protocol` only for breaking changes; add optional fields and capability strings for compatible ones. Bridge should accept `protocol` equal to its own; do not build multi-version negotiation.
- Security (must have, because any web page can open `ws://127.0.0.1`, which is cross-site WebSocket hijacking and gives remote shell):
  - verify the `Origin` header against an allow-list (the app origin and `http://localhost:*` for dev) in `verifyClient` or the `upgrade` handler;
  - verify `Host` is `127.0.0.1:PORT` or `localhost:PORT` (DNS rebinding defence);
  - generate a random token at startup, print it in the URL or QR the user opens, and require it in `hello`; compare with `crypto.timingSafeEqual`;
  - bind to `127.0.0.1` only, never `0.0.0.0`.

Simplification choice: I recommend against ttyd-style ack-based flow control on the client. Server-side watermarks in section 2 are simpler and sufficient on loopback.

## 4. One-shot exit code and clean output

Options ranked for the model tools:

1. No-PTY `child_process.spawn(cmd, { shell: true })` for one-shot. You get separate stdout/stderr, no ANSI colour (most tools disable colour when not a TTY), no echo, no prompt, and an exact `close` event with `code` and `signal`. This is what most agent harnesses do for their non-interactive tool call (Claude Code Bash and Codex exec behave this way; unverified against their source). Downsides: programs that need a TTY (`ssh`, `sudo` prompts, `top`, npm progress) behave differently.
2. PTY running the command directly (`pty.spawn(shell, ['-lc', command])`). `onExit` gives the exit code. Output has CR/LF and ANSI. Use when `tty: true`. No markers needed because the process is the command.
3. Persistent interactive shell: markers required, because the shell never exits. Preferred order:
   - OSC 633 / 133: inject a shell hook so the shell emits `ESC ] 633 ; C BEL` before the command output and `ESC ] 633 ; D ; <exit> BEL` after it. Bash: `PROMPT_COMMAND`; zsh: `precmd`/`preexec`. Spec: [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration); OSC 133 A-D is the compatible Final Term subset.
   - Simpler and fully sufficient: wrap each model-issued command as `{ cmd; } ; printf '\n__SAGENT_<nonce>_%d__\n' $?` and scan the stream for the nonce line. Works in bash and zsh without hooks; wrong for fish (`$status`) and Windows. Use a fresh random nonce per call so output cannot spoof it.
   - Warp and OpenHands: Warp uses its own hook-based block detection; OpenHands drives tmux and detects a PS1 metadata marker (unverified for both).
   Recommendation: nonce wrapper for the persistent shell, since it needs no shell config. Add OSC 633 only if you later want the UI to show command boundaries.

Cleaning output for the model:
- `strip-ansi` 7.2.0 handles SGR and most CSI/OSC sequences. It does not interpret cursor movement, `\r` overwrite, or clear-screen, so progress bars and TUIs come out garbled.
- For faithful text, feed bytes into `@xterm/headless` 6.0.0 (a real terminal emulator without DOM) and read the buffer, or use `@xterm/addon-serialize` 0.14.0 to snapshot the screen. This gives what a human would see. Costs about 1 MB unpacked (xterm is 5.9 MB unpacked in total, headless is a subset) and CPU per byte.
- Recommendation: `strip-ansi` plus `\r\n` to `\n` normalisation for one-shot results by default; add a `screen` read mode backed by `@xterm/headless` only for interactive sessions, when needed.
- Always truncate model-bound output (head and tail with a byte count) and return `nextOffset` so the model can page.

## 5. Frontend: xterm.js with React 19

Versions (npm, 2026-09-29): `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-serialize` 0.14.0, `@xterm/headless` 6.0.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-unicode11` 0.9.0. The old `xterm` and `xterm-addon-*` packages are deprecated; use only the `@xterm/*` scope.

6.0.0 changes ([release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)): canvas renderer addon removed (use DOM or WebGL), new scrollbar, ESM builds, synchronized output (DEC 2026), `windowsMode`/`fastScrollModifier` options removed. The app is on React ^19.2.8 and Vite ^8.3, so ESM is a good fit.

Integration pattern (no code in report, per repo rule of no comments):
- One `useEffect` with `[]` deps creating `new Terminal`, loading `FitAddon` and `WebLinksAddon`, calling `term.open(ref.current)`, `fit.fit()`; the cleanup calls `term.dispose()`. Keep the `Terminal` in a ref, or better in a store keyed by session id, so switching panels does not recreate it.
- StrictMode double-mount: the effect runs, cleans up, runs again in dev. `dispose()` in cleanup and creating in the effect (never in render or module scope) is enough. Do not open the WebSocket inside the terminal effect; own the socket in a store (zustand fits) so the double-mount does not create two sessions.
- Resize: `ResizeObserver` on the container, debounce with `requestAnimationFrame`, call `fit.fit()`, then send `resize` with `term.cols/rows`. Skip `fit()` when the container is `display: none` or zero-sized, otherwise you get 0 cols. Send the initial `create` only after the first fit so the PTY starts at the right size.
- Reattach: on attach, `term.reset()` then write the replayed `output` frames in offset order, tracking `nextOffset` to drop duplicates. Write with `term.write(data)`; for large replays use the write callback to avoid blocking the main thread.
- Theme: pass `theme: { background, foreground, cursor, ... }` from the Tailwind v4 CSS variables (read via `getComputedStyle`), and update `term.options.theme` on theme change. Import `@xterm/xterm/css/xterm.css` once. Set `allowProposedApi` only if an addon needs it.
- Renderer: DOM renderer by default. `addon-webgl` is faster for heavy output but needs context-loss handling (`onContextLoss` then dispose the addon). Skip it initially; add it if output scrolling is slow.
- Bundle: `@xterm/xterm` unpacked is 5.9 MB on disk; the shipped JS is on the order of 300 to 400 KB minified (unverified estimate; measure with the Vite build). Lazy-load the terminal panel with `React.lazy` so it stays out of the main chunk.
- Pitfalls: focus stealing with the chat input (call `term.focus()` only on panel click), `Ctrl+C` copy conflicts (use `attachCustomKeyEventHandler`), IME and paste handled by xterm itself, and `unicode11` addon only if wide-char widths look wrong.

## 6. Packaging and compatibility

Repo layout, ranked:
1. Same repo, pnpm workspace (recommended). Add `pnpm-workspace.yaml` with `packages: ['packages/*']`. Leave the app at the repo root so no files move and no app config changes. The bridge lives in `packages/sagent-bridge`.
2. Separate repo. Cleaner release cadence but forces publishing the types as a package and coordinated PRs. Overkill for one maintainer.
3. Move the app to `apps/studio`. Nicer symmetry but a large diff for no functional gain.

Publishing a CLI with a native dep:
- `package.json`: `"type": "module"`, `"bin": { "sagent-bridge": "dist/cli.js" }`, `"engines": { "node": ">=20" }`, `"files": ["dist"]`, `"exports"` with `"."` and `"./protocol"`. `dist/cli.js` needs a `#!/usr/bin/env node` first line (tsup or tsc keeps it if it is in the source). Build with `tsup` (ESM, target node20).
- Dependencies: `ws` and `@lydell/node-pty` as regular `dependencies`. Because the fork's platform binaries are optionalDependencies, `npx sagent-bridge` on macOS arm64 downloads only the darwin-arm64 package. Do not use `--no-optional` in docs.
- Do not add an `install`/`postinstall` script: it would be blocked under npm 12 and pnpm (build scripts must be approved).
- Add a startup self-check: `try { import('@lydell/node-pty') } catch` and print the platform and a fix hint, then continue in no-PTY mode.
- Scope: the name `sagent-bridge` must be free on npm; run `npm view sagent-bridge` before committing to it (not checked here).

Shared protocol types:
- Recommended: a single file `packages/sagent-bridge/src/protocol.ts` (types, `PROTOCOL_VERSION`, tiny type guards), exported as `sagent-bridge/protocol`. The app adds `"sagent-bridge": "workspace:*"` as a devDependency and uses `import type` plus the one constant, so no native code ever enters the browser bundle. This satisfies DRY without a third package.
- Rejected: copying types (drift) and a separate `@sagent/protocol` package (extra release unit).
- If the app is ever deployed independently from the workspace, the workspace protocol dependency still resolves because the bundler inlines the types; only the constant needs the runtime import.

Version compatibility:
- Two numbers: `protocol` (integer, breaking) and `bridgeVersion` (semver, informational). The app hard-codes the `protocol` it speaks; mismatch produces an actionable UI message.
- Publish the bridge with semver where any protocol bump is a major version, and note the required app version in the README.

## Limitations

- I did not install or run `@lydell/node-pty` on Linux or Windows; the platform list comes from `npm view` optionalDependencies and secondary sources.
- I did not verify the wire byte values for ttyd, or the terminado/gotty/wetty schemas from primary source; only ttyd's command names and VS Code's OSC 633 letters were fetched.
- Harness internals for Claude Code, Codex, OpenHands and Warp are from prior knowledge, not fetched docs.
- Bundle size numbers for xterm are estimates.

## Unresolved questions

1. Will the app be served over HTTPS in production? Safari may block `ws://127.0.0.1` from an HTTPS page as mixed content; Chrome and Firefox treat loopback as secure (unverified). This decides whether the bridge needs a local TLS cert or the app must be used over `http://localhost`.
2. Is Windows a supported target? It changes the shell wrapper (nonce marker with `$?`) and the `@lydell` win32 packages need a real test.
3. Is Alpine/musl Linux relevant to your users? The fork's Linux prebuilds are glibc only per search results.
4. Are you comfortable depending on a beta fork as the default, or do you prefer Microsoft's `node-pty` with a documented Linux toolchain requirement?
5. Should the model see a plain-text stream (strip-ansi) or a rendered screen (`@xterm/headless`) for interactive sessions? That decides whether the headless dependency ships in v1.
6. Should the persistent shell be used by model tools at all in v1, or only one-shot commands plus a user-facing terminal?

## Sources

- https://github.com/microsoft/node-pty
- https://github.com/lydell/node-pty
- https://github.com/pingdotgg/t3code/issues/7847
- https://github.com/websockets/ws/blob/master/doc/ws.md
- https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c
- https://github.com/jupyter/terminado
- https://code.visualstudio.com/docs/terminal/shell-integration
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- npm registry metadata via `npm view` (node-pty, @lydell/node-pty, ws, @xterm/*, strip-ansi, bun-pty, @homebridge/node-pty-prebuilt-multiarch), plus the node-pty@1.1.0 tarball listing.
