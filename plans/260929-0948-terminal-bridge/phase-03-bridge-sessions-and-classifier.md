---
phase: 3
title: "Bridge sessions and command classifier"
status: completed
priority: P1
effort: "12h"
dependencies: [2]
---

# Phase 3: Bridge sessions and command classifier

## Goal
Run exec and PTY sessions confined to the root, with byte-offset output that survives reconnects, and kills that leave no orphan processes, including shell background jobs. Classify commands and typed input so that splitting, history keys and shell escapes cannot get past the prompt. Add a root-binding probe.

## Key Insights
- `@lydell/node-pty` ships per-platform prebuilds and has no install script, so it works under npm 12's install-script block ([package report](../reports/researcher-260929-1643-pty-package-and-xterm.md) §1).
- An interactive shell puts each background job in its own process group. `kill(-pgid)` therefore misses `pnpm dev &`. Kill by POSIX session id instead, with `pkill -s <sid>`, which both BSD and procps provide. <!-- Red Team: PTY kill -->
- tree-sitter-bash does not parse zsh syntax. Model-run commands therefore always go through `/bin/bash --noprofile --norc`. That way the grammar matches the shell that runs the command, and profile aliases and functions cannot hide it. <!-- Red Team: classifier gaps -->
- Classifying each `terminal_write` on its own can be split up or replayed. The bridge owns the PTY, so it tracks the pending line and the foreground process, and classifies the whole line when it is submitted. <!-- Red Team: terminal_write bypass -->
- `tree-sitter-bash@0.25.1` has an `install: node-gyp-build` script. Keep it as a devDependency only, and copy its wasm into `dist/` at build. <!-- Red Team: supply chain -->

## Files to Create / Modify
- Create: `packages/sagent-bridge/src/pty.ts`. `spawnPty()` wraps a guarded dynamic import of `@lydell/node-pty@1.2.0-beta.15`.
- Create: `packages/sagent-bridge/src/ring-buffer.ts`. A byte-offset ring buffer, 1 MiB per session. Reads are aligned to UTF-8 character boundaries.
- Create: `packages/sagent-bridge/src/sessions.ts`. The session registry: spawn, kill, `killOwned`, reaping and limits.
- Create: `packages/sagent-bridge/src/kill.ts`. `killSessionTree(sid)`.
- Create: `packages/sagent-bridge/src/confine.ts`. cwd realpath checks, the env allowlist and the broad-root rule.
- Create: `packages/sagent-bridge/src/classify.ts`. The tree-sitter-bash command classifier.
- Create: `packages/sagent-bridge/src/line-tracker.ts`. Per-session pending-line model and foreground-process check, used by `classifyInput`.
- Create: `packages/sagent-bridge/src/plain.ts`. Converts raw output to plain text.
- Modify: `packages/sagent-bridge/src/server.ts`. Routes messages and pushes `output`, `exit` and `sessions`.
- Create: tests `ring-buffer.test.ts`, `confine.test.ts`, `classify.test.ts`, `line-tracker.test.ts`, `plain.test.ts`, `sessions.test.ts`.

## Sessions
- **exec.** `spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`.
  - `stdin: 'ignore'` stops editors and prompts from hanging.
  - stdout and stderr share one buffer, in arrival order.
  - The session exposes `exitCode` and `signal`.
  - The timeout defaults to 120 s with a maximum of 600 s. On timeout the bridge kills the session and reports `timedOut`.
- **pty.** Two shell modes:
  - `shell: 'model'` spawns `/bin/bash --noprofile --norc -i` for a shell, or `/bin/bash --noprofile --norc -c <command>`.
  - `shell: 'user'` spawns `$SHELL -l` (when it is listed in `/etc/shells`, otherwise `/bin/sh`). This is the user's own login shell, for panel sessions.
  - Terminal settings: `name: 'xterm-256color'`, cols and rows clamped to 2–500. PTY sessions have no timeout.
  - If the PTY library cannot load, `create { kind: 'pty' }` returns `pty_unavailable`.
- **Env.** `PATH` comes from the bridge's own process env, because the bridge was started from the user's terminal and already has nvm and pnpm on the path. The rest is an allowlist: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `SAGENT_BRIDGE=1`. `SAGENT_BRIDGE_TOKEN` and every other bridge variable are removed.
- **Offsets and output.**
  - Every chunk is appended to the ring buffer and broadcast as `output { offset }`.
  - `read` returns `{ data, fromOffset, nextOffset, truncated }`. With `sinceOffset` omitted, it returns the last `maxBytes` bytes (default 64 KiB).
  - Window edges move forward to a UTF-8 lead byte.
- **Plain text (`plain.ts`).**
  - `strip-ansi@7.2.0`, run after dropping a partial escape sequence at the start of the window.
  - `\r\n` becomes `\n`.
  - When a line contains lone `\r` progress rewrites, only the last segment is kept.
- **Backpressure.** When a client's `bufferedAmount` is over 1 MiB, the bridge skips live `output` frames to that client, and the client catches up with `read`. The PTY is never paused. <!-- Red Team: scope trims -->
- **Limits.** At most 16 live sessions and 8 KiB of `input` per frame.
- **Reaping.** An exited session stays for 30 minutes so late reads work. A running session lives until it is killed, `killOwned` matches it, or the bridge exits.
- **Kill (`kill.ts`).**
  1. `pkill -HUP -s <sid>`, then `-TERM` after 500 ms, then `-KILL` after 3 s for anything still present in that session.
  2. `pgrep -s <sid>` must come back empty.
  - For exec, `detached: true` makes the child a session leader, so the rule is the same.
- **killOwned.** Kills every running session whose `owner.threadId` or `owner.runId` matches. The app calls it on sub-agent stop, thread deletion and tool abort (phase 6). Vault lock does not call it, per the user decision that sessions keep running across a lock.
- **Exit cleanup.** Kill every session on SIGINT, SIGTERM and `exit`. No pidfile is kept. <!-- Red Team: pidfile removed -->

## Confinement
- **cwd.** Resolved against the root, then `fs.realpath`. The result must equal the root realpath or start with the root plus `/`. Otherwise the call returns `cwd_outside_root`. A missing directory returns `bad_request`.
- **Not a sandbox.** Neither the shell nor a program can be stopped from `cd`-ing elsewhere. The README says so.

## Command classifier (`classify.ts`)
`web-tree-sitter` is pinned to the 0.25.x release that matches the grammar. It loads `dist/tree-sitter-bash.wasm`. `classify(command)` returns `{ sensitive, reasons, commands }`.

**Sensitive because the command is not simple:**
- a parse error
- command or process substitution
- parameter expansion in a command name
- a heredoc
- any redirection other than to `/dev/null` or a `2>&1`-style merge
- subshells, functions and control flow
- `eval`, `exec`, `source` or `.`
- wrapper commands (`xargs`, `env <cmd>`, `nohup`, `time`, `command`, `sudo`), which are also unwrapped and classified

**Sensitive because of the name or arguments**, matched on normalized argv after unquoting:
- `sudo`, `su`, `doas`
- `rm` with `-r`/`-f`
- `dd`, `mkfs*`, `fdisk`, `diskutil`
- `chmod` or `chown` with `-R`
- `kill`, `pkill`, `killall`
- `shutdown`, `reboot`, `launchctl`, `systemctl`
- `git push --force|-f|--mirror|--delete`, `git reset --hard`, `git clean -f`, `git filter-branch`
- `npm|pnpm|yarn publish|unpublish`, `npm login`
- `ssh`, `scp`, and `rsync` to a remote
- `curl` or `wget` piped into a shell or interpreter, or with upload flags (`-d @`, `--data-binary @`, `-T`, `-F …=@`)
- inline-code interpreters: `sh -c`, `bash -c`, `python -c`, `node -e`, `perl -e`, `ruby -e`

**Sensitive because a path leaves the root:** any argument that is absolute or starts with `~` and resolves outside the root. This also covers reads such as `cat ~/.ssh/id_rsa`.

Anything else is not sensitive. Reasons are short labels, such as `recursive delete` or `reads outside workspace`.

Running scripts from the workspace (`sh x.sh`, `pnpm test`) is deliberately not sensitive, following the user's decision to prompt only for a set of sensitive commands. The README documents that a script the model writes can do anything.

## Input classifier (`line-tracker.ts`, `classifyInput`)
**Tracked state:**
- The bridge keeps each session's pending line from model-origin input. It applies printable characters and backspace. The line is marked `opaque` when it contains cursor keys, `tab`, `ctrl-r`, bracketed paste or other escape sequences.
- The foreground program is read from node-pty's `process` property.

**On submit** (`\r`, `enter` or `submit: true`):
- **Foreground is the session's own bash:**
  - An `opaque` line is sensitive (`history or completion`).
  - Otherwise the full line is classified with `classify()`.
- **Foreground is any other program (REPL, pager, editor, prompt):** only `y`, `n`, `yes`, `no`, `q`, an empty line, `ctrl-c` and `ctrl-d` pass without a prompt. Anything else is sensitive (`input to <program>`).

**Without submit:** text and keys update the buffer and are never sensitive on their own.

**Scope:** user-origin input from the panel is not tracked, because the user is the actor. The model cannot write to user sessions (phase 6).

## Root probe
`verifyRoot { nonce }`:
1. Reads `<root>/.sagent/bridge-probe-<nonce>` (lstat must show a regular file inside the root, at most 256 bytes).
2. Returns `ok { matches: content === nonce }`.
3. Deletes the file.

On start, the bridge also deletes leftover `bridge-probe-*` files. <!-- Red Team: root binding -->

## Tasks & Steps
1. `ring-buffer.ts` and `plain.ts`, test first. Cases: wraparound, `truncated`, a window starting mid-UTF-8 character, a window starting mid-escape sequence, and `\r` progress bars.
2. `confine.ts`. Cases: a `..` escape, a symlink escape, `/work` vs `/work-evil`, and no token in the env.
3. `pty.ts` with the load-failure fallback.
4. `kill.ts` and `sessions.ts`, tested with real processes:
   - `echo hi` exits 0 and `exit 3` exits 3.
   - `cat` exits right away, because stdin is ignored.
   - A timeout.
   - Exec `sh -c 'sleep 60 & wait'` and a PTY shell running `sleep 60 &` both leave nothing after kill (`pgrep -s` is empty).
   - A PTY `read -p` answered through `input`.
   - Reattach from an offset.
   - `killOwned` by `runId`.
   - The session limit.
5. `classify.ts`, table-driven with at least 70 cases. Include every bypass class from security report §4 and the outside-root path rule.
6. `line-tracker.ts`. Cases:
   - `rm -r` + `f ~` split across writes is sensitive at submit.
   - `up` + `enter` is sensitive.
   - `vim` in the foreground with `:!rm -rf ~` is sensitive.
   - `y` to a `read -p` is safe.
   - A Python REPL `print(1)` is sensitive.
7. Wire the server routing and the `sessions` push.

## Verification
- `pnpm bridge:test` passes on macOS.
- The same suites pass in a `node:24` Docker container on Linux if Docker is available. Otherwise this is recorded as not verified.
- A packed tarball installed with `npm i --ignore-scripts` on a machine without Xcode CLT starts, and `capabilities` includes `pty`.

## Risks
- `@lydell/node-pty` is a beta maintained by one person. Mitigations: an exact pin, the adapter, and an exec-only fallback.
- The foreground `process` name could be wrong for some programs. Any mismatch is treated as "other program", which fails closed.
