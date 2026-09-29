# sagent-studio

**A local-first AI agent studio that runs entirely in your browser.**

Chat with any OpenAI-compatible model, let it work on a folder on your disk, run code in a
sandbox or a real shell, and preview what it makes. Conversations, keys, and settings stay
encrypted on your machine. There is no backend: the app is a static bundle.

> **Bring your own model.** sagent-studio ships no model and no account. Point it at any
> OpenAI-compatible endpoint and paste your own key.

## Features

- **Chat** with one or more providers, switch models per conversation, and watch a live
  context meter. Conversations compact automatically at 90% of the model's context window
  and name themselves.
- **Model tiers.** Spark, Forge, Prime, and Oracle (Config → Models) pick which model handles
  naming, sub-agents, and other side work.
- **Work on a real folder.** The model reads, searches, creates, and edits files in a folder you
  grant. Every write is journaled per conversation: checkpoint, restore, diff, history.
- **Attach files** by upload, paste, drag and drop, or `@path`. Uploads land in `uploads/`
  so every tool can read them.
- **Rewind** to any message: the conversation and its workspace files go back to that point.
- **Sandbox.** A persistent JavaScript worker and a Python (Pyodide) runtime, isolated from
  the app and with no access to the vault key.
- **Terminal.** The `sagent-bridge` companion gives the model and you a real shell in your
  project folder. See [Terminal bridge](#terminal-bridge).
- **Preview** Markdown, JSON, Mermaid, HTML, CSV/XLSX, DOCX, images, audio, and video.
  Model-written HTML runs in an isolated frame.
- **Sub-agents** run inline or in the background with their own tier, tools, and
  transcript. You can steer, stop, continue, or revert them from the **Agents** panel.
- **Skills and user tools.** Load skills on demand from the workspace or the vault, and add
  your own `sandbox-js` or `http` tools.
- **MCP servers** over Streamable HTTP or SSE, with OAuth 2.1 sign-in. Their tools, prompts
  (`/server.prompt`), and resources (`@mcp`) join the model.
- **Document library.** Encrypted local RAG over text, Markdown, and PDF, with passages gated
  and verified before they reach the prompt.
- **Memories.** The model keeps short notes about you, global or per folder, which you manage
  in the **Memory** panel.

The model reads a detailed guide for each area through `read_tool_guide`. The same guides
are the best reference for people too: [`src/tools/builtin/guides/`](src/tools/builtin/guides/).

## Requirements

- **Chrome or Edge.** Workspace features need the File System Access API. Other browsers open
  the app without them.
- **A secure context** (`https://` or `http://localhost`). The vault uses WebCrypto, so
  `file://` does not work.
- **Node.js 20+ and pnpm** to run from source.

## Quick start

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

1. Create a vault password. It encrypts everything the app stores.
2. Add a provider: an OpenAI-compatible base URL, a model ID, and an API key.
3. Grant a workspace folder. The model works inside it and nowhere else.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server with hot reload |
| `pnpm build` | Type-check and build the static bundle into `dist/` |
| `pnpm preview` | Serve the production build |
| `pnpm test` / `pnpm test:watch` | Run the tests once / on change |
| `pnpm lint` | Lint |
| `pnpm bridge:build` / `pnpm bridge:test` | Build / test the `sagent-bridge` package |

`dev` and `build` first copy the Pyodide runtime into `public/pyodide/`.

## Permission modes

Each conversation runs in one mode, picked in the composer:

| Mode | Behavior |
| --- | --- |
| **Read only** | Inspect and search. Every change asks first. |
| **Editing** | Write files and run code. Destructive actions ask first. |
| **God** | Auto-approve every gated action. Sensitive terminal commands still ask. |

Approval prompts appear above the composer. Allow or deny once, or save the decision per
tool in the **Approvals** panel. A sub-agent never runs above its conversation's mode, and
its approvals queue in the **Agents** panel.

## Terminal bridge

The browser cannot start processes, so a small companion, `sagent-bridge`, runs on your
machine (macOS or Linux, Node 20+) and serves shell sessions over an authenticated
WebSocket on `127.0.0.1`.

**Start it** in your project folder:

```bash
npx sagent-bridge@0.2.0 --root .
```

The bridge prints a pairing link and copies it to your clipboard. Open it, unlock the vault
in that tab, and the **Terminal** panel shows **connected** with your folder name. The link
works once and expires after 10 minutes. The token is new every time the bridge starts, so
after a restart press Enter in the bridge terminal for a new link.

The bridge trusts <https://sagent-studio.vercel.app> by default. When you run the app yourself
(`pnpm dev`), add `--app-url http://localhost:5173`. The Terminal panel always shows the
command for the page you are on.

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Folder sessions run in. It must match the conversation's workspace folder. |
| `--port <n>` | Port on `127.0.0.1` (default `7717`). |
| `--app-url <url>` | Where the app runs, if not `https://sagent-studio.vercel.app`. |
| `--open` | Also open the pairing link in your browser. |
| `--allow-broad-root` | Allow `/`, your home folder, or a parent of it as the root. |

**Tools.** `run_command` runs a command to completion (timeout 120 s, max 600 s).
`terminal_start`, `terminal_write`, `terminal_read`, `terminal_list`, and `terminal_kill`
manage long-running and interactive sessions. The model only sees sessions its own
conversation started. Your shells in the Terminal panel are private to you.

**When commands ask.** The bridge parses every command with a bash grammar and flags it as
sensitive when it, for example, deletes recursively, uses `sudo`, pipes into a shell, runs
inline code, force-pushes, publishes, redirects output, reaches outside the workspace, or
cannot be parsed.

| Mode | Safe command | Sensitive command |
| --- | --- | --- |
| Read only | asks | asks |
| Editing, God | runs | asks |

A saved **Deny** blocks the tool, **Ask** asks every call, and **Allow** runs everything,
sensitive commands included.

**Good to know.**

- The bridge is **not a sandbox**. Commands run as you and can reach anything you can.
  Classification is a prompting aid: a script the model writes and then runs does not ask.
- Rewinding or reverting restores files but cannot undo commands. The preview lists the
  commands that ran.
- Locking the vault disconnects but leaves sessions running. Stopping the bridge (Ctrl+C)
  kills every session and its child processes.
- Chrome may ask to allow local network access the first time. Allow it.

More in the [bridge README](packages/sagent-bridge/README.md) and the
[terminal guide](src/tools/builtin/guides/terminal.md).

## Your data

- **Encrypted at rest.** Conversations, provider settings, API keys, memories, and the
  document library are encrypted with AES-GCM 256 using a key derived from your password (PBKDF2-SHA256). The
  key lives only in memory. Only the salt and key-derivation parameters are stored in the clear.
- **Auto-lock.** The vault locks after 15 minutes idle by default, and on demand.
- **What leaves your machine:**
  - Each turn goes to the model provider you configured.
  - Tool calls, prompts, and resource reads go to the MCP servers you add, and through their
    proxy if you set one.
  - Library ingest and search go to your embedding provider and to TypeSafe. TypeSafe is
    called through a same-origin `/typesafe` proxy, which a static deployment must also
    provide.
  - Nothing else is sent anywhere.
- **Isolation.** Model-written HTML cannot read app storage or the parent page. While a
  bridge is paired, workspace HTML previews lose same-origin access and sandbox workers
  cannot open sockets.

> **There is no recovery.** No recovery key, no password reset, no export. If you forget your
> password, your data is gone. This is deliberate.

## Troubleshooting

- **Cannot pick a folder.** Use Chrome or Edge on `https://` or `http://localhost`.
- **Folder permission lost.** Grants do not survive every browser restart. Re-grant when
  prompted; your files are untouched.
- **Recovery screen instead of "wrong password".** The stored vault is damaged. The app
  offers to erase it and start over.
- **Terminal says *needs pairing*.** The bridge restarted. Press Enter in its terminal and
  open the new link.
- **Terminal says *different folder*.** Restart the bridge with `--root` set to the
  conversation's workspace folder.

## Development

Deploy `dist/` to any static host over HTTPS. Do not deploy it publicly as a shared API-key
proxy: keys live in the browser, so a public deployment should front providers with your
own server.

```
src/
  vault/       encrypted storage, unlock and recovery, idle lock
  ai/          provider registry, model clients, tiers, TypeSafe
  chat/        streaming engine, persistence, compaction, approvals
  agents/      sub-agent runtime, profiles, run transcripts
  tools/       tool registry, built-in tools, and their guides
  workspace/   file system access, search, patching, change journal
  sandbox/     JavaScript worker and Pyodide runners
  terminal/    bridge client, pairing, root binding, command approval
  mcp/         MCP client, transports, OAuth
  rag/         document library, ingest, vector index
  memory/      personal memories
  skills/      skill discovery and loading
  session/     per-conversation state wiring
  settings/    provider, model tier, and storage settings
  ui/          shell, panels, composer, file viewers
packages/
  sagent-bridge/  the local terminal bridge
plans/         design documents and implementation history
```

- The Content-Security-Policy is injected at build time in `vite.config.ts`. It is omitted in
  dev so hot reload works.
- Tests run on Vitest with jsdom and `fake-indexeddb` (setup in `src/test-setup.ts`). The
  terminal tests build and start a real bridge.

### Releasing `sagent-bridge`

The [`sagent-bridge` workflow](.github/workflows/sagent-bridge.yml) tests the package on
Linux and macOS for every change under `packages/sagent-bridge/`. To publish:

1. Bump `version` in `packages/sagent-bridge/package.json` and `BRIDGE_VERSION` in
   `packages/sagent-bridge/src/protocol.ts` (a test fails if they differ), and commit.
2. Push a tag named after the version: `git tag sagent-bridge-v0.1.1 && git push origin sagent-bridge-v0.1.1`.

The publish job checks that the tag matches the version and that the version is not on npm
yet, then stages it with provenance through npm trusted publishing. Nothing is public until
you approve it on npmjs.com, or with `npm stage list sagent-bridge` and
`npm stage approve <id>` (npm 12+), using your 2FA. Running the workflow by hand does a dry
run.
