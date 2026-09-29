# sagent-bridge PTY security research (2026-09-29)

Saved by the orchestrator from the researcher's reply; the researcher could not write files.

## Bottom line

1. Treat the bridge as a remote-code-execution endpoint. Defend in layers: loopback bind, separate Host and Origin allowlists, per-run token, and a human approval gate in the SPA.
2. Use the literal `ws://127.0.0.1:PORT`, not `localhost`. Chrome 147+ gates WebSocket to loopback behind a `loopback-network` permission prompt when the page is https. Dev origin `http://localhost:5173` behavior is untested.
3. Command classification is not a security boundary (10 of 11 surveyed agents' guards were bypassed). Use it only to decide when to prompt; fail closed.
4. Raw PTY keystrokes cannot be classified. Approve at session level, gate model-driven input, and provide a kill switch and idle timeout.
5. Kill by process group on POSIX; `taskkill /T /F` or a Job Object on Windows.

## 1. Browser to localhost WebSocket security

- CSWSH: WebSockets are exempt from the same-origin policy, so any page can open `ws://127.0.0.1:PORT` ([HackerOne 535436](https://hackerone.com/reports/535436)).
- DNS rebinding: a loopback bind does not stop it. A server that only compares Origin to its own Host passes it ([quizify #872](https://github.com/mholzi/quizify/issues/872)).
- Validate Host and Origin each against a fixed allowlist ([MCP conformance #535](https://github.com/modelcontextprotocol/conformance/issues/535)).
- The browser WebSocket constructor takes only a URL and subprotocols.

| Token transport | Leaks | Verdict |
|---|---|---|
| Query string | access logs, proxies, DevTools | Avoid |
| `Sec-WebSocket-Protocol` | visible in DevTools only | Recommended; server echoes one fixed subprotocol |
| First-message auth | none | Good; needs auth timeout, Origin/Host still checked at handshake |
| Cookie | n/a | Not viable cross-origin |

Keep secrets off argv; OpenHands leaked a token via `?tkn=` and `ps` ([software-agent-sdk #4317](https://github.com/OpenHands/software-agent-sdk/issues/4317)). Never pass the bridge token into PTY children.

Recommendations: bind `127.0.0.1` only; Host must be `127.0.0.1:PORT`, `localhost:PORT` or `[::1]:PORT`; Origin from a configured allowlist, no wildcard; token of 128+ bits compared in constant time with limited failed attempts.

## 2. Chrome Local Network Access in 2026

- LNA replaced Private Network Access; prompt shipped in Chrome 142 for fetch ([Chrome blog](https://developer.chrome.com/blog/local-network-access)). Chrome 145 split `local-network` and `loopback-network`; Chrome 147 extended the gate to WebSocket ([chromestatus](https://chromestatus.com/feature/5197681148428288)).
- https site to `ws://127.0.0.1`: Chrome 147+ prompts; deny means connection fails.
- Loopback is potentially trustworthy; Chrome historically treated `127.0.0.1` more reliably than `localhost` hostname ([Chromium 40386732](https://issues.chromium.org/issues/40386732)). Safari unverified.

Recommendations: explain the prompt in pairing UX; probe `GET /health` (CORS-allowlisted) first to distinguish denied prompt, wrong port and bad token.

## 3. Pairing patterns

| Tool | Auth | Origin defense |
|---|---|---|
| Jupyter Server | random token by default ([docs](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)) | not verified |
| VS Code server | mandatory connection token, `--connection-token-file` ([vscode #136615](https://github.com/microsoft/vscode/issues/136615)) | not verified |
| ttyd | optional Basic auth ([man](https://man.archlinux.org/man/extra/ttyd/ttyd.1.en)) | `--check-origin` opt-in, unsafe defaults |
| Chrome remote debugging | none | `--remote-allow-origins` since Chrome 111 |

Recommendations: print a pairing URL with the token in the fragment (`#bridge=...&token=...`), which is not sent to servers; SPA strips the fragment. Origin check and token always on. Rotate token on every start; offer `--token-file`.

## 4. Sensitive command detection

| Tool | Approach | Weakness |
|---|---|---|
| Claude Code | prefix rules, split on operators ([docs](https://code.claude.com/docs/en/permissions)) | chaining bypass reports |
| Codex CLI | `prefix_rule` allow/prompt/forbidden; tree-sitter splits simple scripts, anything complex is opaque ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules)) | fails closed (right direction) |
| Gemini CLI | allowlist | checked only first command of a pipe ([#11510](https://github.com/google-gemini/gemini-cli/issues/11510)) |
| Cline | model sets `requires_approval` | self-classification |
| OpenHands | trusts model's `security_risk` | model can label anything LOW |

Bypass classes: quote removal (`r''m`), `$IFS`, command substitution, pipe to `sh`, alternative flags like `find -delete` ([Adversa](https://adversa.ai/blog/opensource-ai-coding-agents-shell-injection-vulnerability/)).

Ranked recommendation:
1. Parse with tree-sitter-bash (WASM) and fail closed: anything beyond simple commands joined by `&&`, `||`, `;`, `|` is sensitive (substitution, expansion, redirection, heredocs, `eval`, `bash -c`, `sh`, `python -c`, parse errors).
2. Hint list (`rm -rf`, `sudo`, `git push --force`, `curl | sh`, `chmod`, `dd`, `mkfs`, `npm publish`) labels why a prompt appears.
3. Never use the model's own risk flag as an allow signal.
4. Lighter fallback: shell-quote plus "any operator or metacharacter means prompt".

Interactive PTY input (analysis, unsourced): the approval unit is the session; shells and interpreters are sensitive programs; model-driven input should be classified per line when it is a command line, and log every byte; UI kill button and idle timeout.

## 5. Confinement

- POSIX: spawn as a session leader, kill with `process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` after grace. Killing only the direct child leaks grandchildren ([skein #190](https://github.com/timeloop-vault/skein/issues/190)).
- Windows: ConPTY has no process groups; `taskkill /PID <pid> /T /F` or Job Object ([node-pty #437](https://github.com/microsoft/node-pty/issues/437)).

Checklist: cwd realpath must equal or sit under root realpath (trailing-separator compare; a shell can still `cd` away); env from an allowlist, never the token; hard timeout for one-shot, idle and max-lifetime for sessions, concurrency cap; per-session byte cap, ring buffer, `maxPayload`; kill all sessions on bridge exit, persist PIDs and reap at next start; README states there is no sandbox.

## Unresolved questions

1. Does `http://localhost:5173` connecting to `ws://127.0.0.1` trigger the loopback prompt on Chrome 147+? Needs an empirical test.
2. Safari and Firefox behavior for `ws://127.0.0.1` from an https page.
3. Maintenance status of bash-parser.
