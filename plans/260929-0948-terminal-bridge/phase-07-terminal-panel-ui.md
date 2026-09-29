---
phase: 7
title: "Terminal panel UI"
status: completed
priority: P2
effort: "9h"
dependencies: [6]
---

# Phase 7: Terminal panel UI

## Goal
Add a **Terminal** rail panel. In it the user can see the bridge status and fix pairing, watch every session live in xterm.js (model, sub-agent, and their own), type into any session, open new shells, and kill sessions.

## Key Insights
- Rail panels are declared in `src/ui/shell.tsx:395-412`. The id union is at `:59` and `RAIL_IDS` at `:72`, and `sessionStorage` restore validates against `RAIL_IDS` (`:124`). The MCP panel (`src/ui/panels/mcp.tsx`) is the closest reference.
- xterm.js 6 is ESM. Create the `Terminal` in an effect with `[]` dependencies and dispose it in cleanup, which is safe under StrictMode. The manager (phase 4) owns the socket, not the component ([package report](../reports/researcher-260929-1643-pty-package-and-xterm.md) §5).
- `React.lazy` keeps xterm out of the main chunk.
- The user's typing is never gated, because the user is the actor. The model cannot reach user sessions (phase 6).

## Files to Create / Modify
- Modify: `package.json`. Add `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` and `@xterm/addon-web-links@0.12.0`, pinned exactly.
- Modify: `src/ui/shell.tsx`. Add `"terminal"` to `RailPanelId` and `RAIL_IDS`, plus a panel entry with the lucide `SquareTerminal` icon and a lazy `TerminalPanel`.
- Create: `src/ui/panels/terminal.tsx` for status, pairing and the session list.
- Create: `src/ui/terminal/xterm-view.tsx`. It mounts xterm, attaches through `port.subscribe`, forwards input and resize, applies the theme, and fits the terminal.
- Create: `src/ui/terminal/terminal-theme.ts`. It reads CSS tokens with `getComputedStyle` and maps them to an xterm theme.
- Create: `src/ui/terminal/use-terminal.ts`. A hook over `manager.onChange`.
- Tests: `src/ui/panels/terminal.test.tsx` covers:
  - each status with its reason line
  - manual pairing validation
  - the session list with owner chips
  - the kill confirm
  - the subscribe/replay logic, through `use-terminal` and a fake port. The xterm view itself is not rendered in jsdom.

## Panel layout
1. **Status line** (`aria-live="polite"`).
   - `ready`: shows `Connected · root: <rootName> · bridge <version>`.
   - Other states: the status and the reason hint from phase 4, plus **Retry**.
2. **Pairing.** Shown when the status is `unpaired` or `needs-auth`.
   - Primary text: "Run `npx sagent-bridge@<exact version> --root <folder>` and open the link it prints."
   - A collapsible manual form: URL (default `ws://127.0.0.1:7717`) and token in `SecretField` (`src/ai/secret-field.tsx`).
   - **Forget bridge** clears `Settings.terminal`.
3. **Session list.** A listbox with keyboard navigation. Each row shows:
   - an icon for exec or pty
   - the command, or `shell`
   - an owner chip: `you`, `model`, or `agent: <name>`
   - running with elapsed time, or the exit code
   - a kill button, which asks for confirmation only on running `you` sessions
   - Exited sessions go into a collapsed "Finished" group.
4. **Session view.** `XtermView` for the selected session, filling the remaining height. Input is enabled for running sessions. **New shell** creates a `pty` session with `shell: 'user'` and `owner: user`.
5. **Reattach.**
   - On mount, the view calls `subscribe(id, onOutput, 0)`. The bridge replays its ring buffer, and when older output was dropped the view writes a `[earlier output dropped]` line before live output.
   - The last selected id is kept in `sessionStorage`. If the id is not in `sessions()`, the view falls back to the first session in the list.

## Behavior details
- **Theme.** Paper and ink tokens follow the app theme, and a theme change updates `term.options.theme`. JetBrains Mono is already bundled. Scrollback is 5,000 lines.
- **Keys.** `Ctrl+C` or `Cmd+C` copies when there is a selection and goes to the PTY otherwise. The terminal takes focus only on click, so the chat composer keeps focus.
- **Resize.** A `ResizeObserver` triggers `requestAnimationFrame`, then `fit.fit()`, then `port.resize`. It skips the call when the size is zero.
- **Accessibility.** xterm `screenReaderMode` is on.

## Tasks & Steps
1. Add the dependencies, the lazy panel and the rail entry.
2. Build status and pairing on `use-terminal`.
3. Build `XtermView` with attach, input and resize.
4. Build the session list.
5. Write the panel tests.
6. Check the bundle: a separate xterm chunk loads only when the panel opens.

## Verification
- `pnpm test` and `pnpm lint` pass.
- `pnpm build`, run only after the user OKs it, shows a lazy xterm chunk.
- Manual:
  - Open **New shell** and run `vim`. The TUI renders and reflows on resize.
  - Reload the page, and the session reattaches with its scrollback.
  - A `run_command` started by the model appears as `model`.
