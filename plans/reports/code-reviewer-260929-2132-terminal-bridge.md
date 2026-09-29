# Code review: terminal bridge (2026-09-29)

Reviewer: code-reviewer subagent (fresh context). Status: DONE_WITH_CONCERNS.

Checks green at review time: `npx tsc -b`, `pnpm lint`, bridge typecheck, `pnpm bridge:test` (275), `pnpm test` (2028, 1 skipped). `pnpm build` not run.

## Findings

### Critical
- **C1. History replay and line-editing reset bypass `terminal_write` classification.** The model shell ran `-i` with in-memory history. The line tracker cleared `opaque` on Ctrl-U and Ctrl-C. Proven on a real PTY: `Ctrl-P Ctrl-P Ctrl-A Ctrl-U` + Enter, `!touch`, `!!`, and `rm -rf x Ctrl-A Ctrl-U Enter` were all classified safe and ran.
- **C2. Two `terminal_write` calls in one step bypass the split-input check.** The SDK approves every call in a step before running any, so both are classified against the same tracker state. `rm -rf victim` (no submit) followed by `keys:['enter']` deleted the folder.

### High
- **H1. `classify()` misses simple equivalents:**
  - globs in the command name (`/bin/r? -rf`)
  - `env -S`, `coproc`, `trap`
  - combined short flags (`node -pe`, `curl -sd @f`)
  - pipes into a shell through a wrapper (`| nice sh`), and extra shells (`tcsh`, `busybox`)
  - abbreviated long options (`rm --recu`, `git reset --har`)
  - package-manager exec, `git rebase -x`, `git submodule foreach`, `git config`, `tar --checkpoint-action`, `sed e`, `watch`, `script -c`, `rsync -e`, `pkexec`
  - `alias`, `PS1` and `bind -x` in the interactive shell
  - bare `cd`
- **H2. A workspace preview already open before pairing keeps same-origin access.** Changing the `sandbox` attribute does not apply until the frame navigates again.
- **H3. `run_command` drops the end of large outputs.** It read a 120 KB window from offset 0 and truncated its middle.

### Medium
- **M1.** `setsid` and similar commands detach from the session and escape the kill tree.
- **M2.** `WebSocketStream` was not removed from sandbox workers.
- **M3.** Tty matching re-snapshots during the kill, so a reused tty could be hit.
- **M4.** The globalSetup build hides its output on failure.

### Low
- A nested `bash` counts as the model shell.
- Approved calls run in parallel on resume.
- The socket leaks if `saveConfig` throws after hello.
- Deleting a thread while disconnected leaves its sessions running.
- `handleFor` falls back to the global folder.
- Token redaction is literal only.

## Deviations
All six deviations were judged sound. Add `WebSocketStream` to the worker lockdown.

## Resolution
See the implementation report and the plan status for what was fixed.
