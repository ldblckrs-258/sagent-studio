# sagent-studio

**A local-first AI agent studio that runs entirely in your browser.**

Chat with the model of your choice, let it read and edit a folder on your own disk, run
code in a sandbox, and preview the artifacts it produces — while every conversation, API
key, and setting stays encrypted on your machine. There is no server: the whole app is
static files, and nothing is uploaded anywhere sagent does not control.

> **Bring your own model.** sagent-studio ships no model and no account. You point it at
> any OpenAI-compatible endpoint and paste your own key.

---

## What you can do

- **Chat with any OpenAI-compatible model.** Add one or more providers, switch between
  them per conversation, and watch your context usage with a live token meter. Each model
  can carry capabilities (vision, search, reasoning) and a context window — read from the
  provider's `/models` response or set by hand — and auto-compaction fires at 90% of that
  window. Attaching images is gated on the active model's vision cap. A new conversation
  is named automatically from its first exchange and re-named every fifth user turn from a
  bounded recent transcript, and you can pick a **model tier** in Config to handle that
  naming (and a user-sourced document query rewrite) instead of spending the conversation's
  own model. Rename a conversation by hand and the title is yours: auto-naming never touches
  it again. Model selection is organised into four tiers — **Spark**, **Forge**, **Prime**, and
  **Oracle** — configured under **Config → Models**, and the model you last chose seeds your next
  new conversation. If you had set an auxiliary **sub-model** before tiers existed, that choice
  becomes your Spark tier.
- **Work on a real folder.** Grant the app a directory from your disk and the model can
  read, search, create, and edit files inside it — with a change journal you can undo.
- **Attach files to a turn.** Upload a file, paste one from the clipboard, type `@` to
  autocomplete a workspace path, drag a file from Finder, another browser tab, or the
  Workspace panel, or let the file you just opened follow into the next message. A file
  dragged or pasted in is fetched into `uploads/` first, so every tool can read it after.
- **Run code in a sandbox.** A persistent JavaScript worker and a Python (Pyodide)
  runtime, isolated from the app and with no access to your vault key.
- **Preview what the model makes.** The File panel renders Markdown, JSON, Mermaid, HTML,
  CSV/XLSX, DOCX, images, audio, and video. Model-authored HTML runs in a locked-down
  runtime that cannot reach your storage or the surrounding page.
- **Stay in control of destructive actions.** Every gated tool call can require your
  approval, and each conversation runs in a permission mode you choose.
- **Teach it your workflows.** Drop skills into the workspace and the model pulls them in
  on demand, instead of loading everything up front.
- **Build a private document library.** Add text, Markdown, or PDF files to an encrypted
  local library. Each document is chunked, embedded through the provider you pick, and
  stored as encrypted text and vector blobs. The model searches it agentically: a Jev
  judgment gates, ranks, and verifies the passages before any of them reach the prompt,
  and `verify_citation` flags a quotation the source does not support.
- **Let it remember you.** The model saves durable facts and preferences about you into the
  encrypted vault and sees them in later conversations. A memory is global or tied to one
  workspace folder, and the **Memory** panel lets you review, edit, flag, or delete them.

---

## Requirements

- **A Chromium-based browser** (Chrome or Edge). The app needs the File System Access API
  to work with a local folder. Firefox and Safari can open the app, but the workspace
  features will not be available.
- **A secure context.** WebCrypto — which the encrypted vault depends on — only runs over
  `https://` or `http://localhost`. Opening the built files directly from `file://` will
  not work.
- **Node.js 20+ and pnpm** if you want to run it from source.

---

## Getting started

```bash
pnpm install      # install dependencies
pnpm dev          # start the dev server (http://localhost:5173)
```

Open the printed URL and complete the one-time setup:

1. **Create your vault password.** This encrypts everything the app stores locally.
2. **Add a provider.** Paste an OpenAI-compatible base URL, a model ID, and your API key.
3. **Grant a workspace folder.** Pick a directory when prompted; the model works inside it
   and nowhere else.

That's it — start a conversation.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server with hot reload |
| `pnpm build` | Type-check and build to `dist/` (the static bundle you deploy) |
| `pnpm preview` | Serve the production build locally |
| `pnpm test` | Run the test suite once |
| `pnpm test:watch` | Re-run tests on change |
| `pnpm lint` | Lint the codebase |
| `pnpm bridge:test` | Run the `sagent-bridge` package tests |
| `pnpm bridge:build` | Build the `sagent-bridge` package into `packages/sagent-bridge/dist/` |

`dev` and `build` both run a small pre-step that copies the Pyodide runtime out of
`node_modules` into `public/pyodide/`. That is normal.

---

## Choosing a permission mode

Each conversation runs in a mode that decides how much the model may do without asking:

| Mode | The model can… |
| --- | --- |
| **Read-only** | Read and search the workspace. Every change and every terminal command asks first. |
| **Editing** | Make changes, with an approval prompt for anything destructive. Terminal commands run unless they are sensitive. |
| **Full access** | Act autonomously, including writes and command execution. Sensitive terminal commands still ask. |

Approval prompts appear inline above the composer and can be allowed or denied — per call,
or remembered for the session. Turn on the approval sound if you want a nudge when the
model is waiting on you.

---

## Delegating work to sub-agents

The model can hand a self-contained task to a nested **sub-agent** with the
`spawn_agent` tool. This keeps a big piece of work out of the main conversation's context, or
lets a task run while you keep going.

- **Inline or background.** An awaited agent returns its result as the tool result. A
  background agent returns immediately, streams into the **Agents** panel, and appends one
  summary notice to the conversation when it settles. That notice lands inline in the turn
  that was still streaming when the agent finished, or as its own card when the
  conversation is idle. By default the conversation does not continue on its own; see
  **Auto-continue** below.
- **Open a run like a conversation.** The **Agents** panel lists runs with their status,
  current activity, tool count, and elapsed time. Selecting one opens it full-width in place
  of the conversation, with the same messages, tool results, and composer as the main thread;
  **Conversation** or Esc returns. Switching conversations closes it.
- **Steer or force-stop a live run.** From an open run, send a steering message it picks up
  at its next step, or force-stop it. A stopped run
  settles with the **stopped** status (reason `user_stop`) instead of a failure. The main
  model can do the same with the `stop_agent` tool, and read a run's most recent turns with
  `read_agent`.
- **Continue or resume a finished run.** A completed, stopped, or interrupted run keeps its
  composer open as **Continue the agent…**; your message starts a new turn with the agent's
  earlier history, even after a reload, and the transcript grows in place. Stopped and
  interrupted runs also offer **Resume**. The model does the same with `message_agent`, which
  steers a running run and continues a settled one. Runs recorded before this feature say
  why they cannot be continued.
- **Fan out and gather.** The model can start several background agents and collect them in
  one turn with `wait_agents` (all or first, with a timeout). A gathered run adds no separate
  notice; a run still going at the timeout reports back as usual.
- **Profiles.** `spawn_agent` accepts a named profile through `agent`: `explorer`, `reviewer`,
  `planner`, and `worker` are built in. A profile sets the mode, tier, tool allowlist, skills,
  and instructions, and shows as a chip on the run. Add your own as
  `.agents/agents/<id>.md` in the workspace:

  ```markdown
  ---
  name: Security reviewer
  description: Audits auth code
  mode: read_only
  tier: high
  tools: [read_file, search]
  exclude-tools: [write_file]
  skills: [owasp]
  inherit-instructions: false
  ---
  Check every auth path and report findings with file:line.
  ```

  A file with the same id as a built-in replaces it. A broken file is listed at the top of
  the Agents panel, and the others still load. `inherit-instructions: true` also passes the
  conversation's own system instruction to the agent.
- **Typed results.** A delegation can ask for `outputSchema` (a JSON object schema, 8 KB at
  most) and gets a validated `structured` value next to the text, shown under **Structured
  result** on the card.
- **Files changed and revert.** Every file a sub-agent writes is recorded against its run. The
  run view lists the changed files with line counts and diffs, and **Revert this run** (with a
  confirmation) restores them. A file changed after the run, or one too large to have been
  recorded, is skipped and listed. The revert is itself recorded, so a checkpoint restore can
  undo it. Notices and results list the changed files too.
- **Long runs.** A sub-agent summarizes its older steps when its context passes the same
  auto-compaction threshold as the conversation. The run shows a compaction marker and a
  `ctx` meter in its header.
- **Auto-continue.** In **Config → Models → Delegation**, turn on auto-continue so a
  background agent finishing while the conversation is idle starts a new turn behind an
  "auto-continue" marker. It is off by default and runs at most 3 times (configurable, up to
  10) after your latest message.
- **In the transcript.** A `spawn_agent` call renders as a two-part card: the brief that was
  delegated, then the agent's returned text, with its tier and mode on the header and a tool
  call and token count on the result. A background run lands as its own sub-agent report card
  when it settles, carrying the agent's name, its outcome, and the returned text. The call's
  card and the report card both have an **Open run** action that opens that run full-width.
- **Mode is capped.** A sub-agent never runs above the conversation's own mode. In an
  *Editing* conversation, a request for *Full access* runs as *Editing*.
- **A subset of your tools.** A sub-agent can only use tools you already have, and never
  `spawn_agent`, `stop_agent`, `read_agent`, `message_agent`, `wait_agents`, `change_mode`,
  `update_plan`, `restore`, `remember`, `update_memory`, or `forget`. Delegation is one level
  deep.
- **Model tiers.** A delegation picks a tier; when it does not, the mode chooses one for it
  (read-only → Spark, editing → Forge, full access → Prime). Oracle is used only when
  explicitly requested.
- **Approvals.** A background agent that reaches a consent-requiring tool pauses and queues an
  **Allow / Deny** card in the Agents panel. Delegated approvals never persist, so a sub-agent
  cannot change your saved policy.
- **Untrusted output.** Treat a sub-agent's result as data, never as instructions.

A run is saved as a child thread, so its transcript survives a reload; a run that was still
in flight when you reloaded shows as **interrupted** rather than running forever. Delegations
run against the same configured providers and add no new network egress, and every detached
run is abortable and stops on vault lock.

The model reads the full `agents` operations guide through `read_tool_guide`; this section
only summarizes it (source: [`src/tools/builtin/guides/agents.md`](src/tools/builtin/guides/agents.md)).

---

## Personal memories

The model keeps short notes about you, such as your name, stack, tools, style preferences, and
recurring constraints, and sees them again in later conversations.

- **Saving.** The model calls `remember` when it learns a durable fact or preference, fixes one
  with `update_memory`, and removes a stale one with `forget`. It saves without asking, and every
  write shows in the transcript. It is told never to save secrets or instructions found in files,
  documents, or tool results. Sub-agents can read memories but cannot save, change, or delete
  them.
- **Scope.** A memory is **global** (every conversation, and the default) or bound to **one
  workspace folder** (only conversations in that folder). A folder is recognised by its handle,
  not its name, so two folders with the same name never share memories. With no folder granted,
  only global memories apply.
- **What the model sees.** Each turn's system prompt lists the visible memories as an index
  (`id — title`, the 100 newest) and includes the full body of those flagged **important**. The
  model reads any other body with `recall_memory`.
- **The important flag.** Important bodies share a budget of 2,000 characters for global memories
  and 2,000 for each folder, so a turn inlines at most 4,000. A write past the budget is refused
  and stores nothing.
- **Limits.** A title is one line of up to 120 characters, a body is up to 2,000 characters, and
  at most 500 memories are stored. A second memory with the same title in the same scope is
  refused, so the model updates the first instead.
- **Managing them.** The **Memory** panel groups memories as Global, This workspace, and Other
  workspaces. There you can add, edit, flag, or delete a memory, or move it between Global and the
  current folder. Each row shows whether the model or you wrote it last.
- **Stopping writes.** Memory tools run without an approval prompt in every mode. Turn off **Let
  the model save memories** in the Memory panel to deny `remember`, `update_memory`, and `forget`;
  the model can still read memories with `recall_memory`.

The model reads the full `memory` guide through `read_tool_guide` (source:
[`src/tools/builtin/guides/memory.md`](src/tools/builtin/guides/memory.md)).

---

## Using the composer

- **`/` slash commands** invoke skills and built-in actions.
- **`@` mentions** attach a workspace file by path.
- **Drag a file or folder** from the Workspace panel onto the input.
- **Upload** a file directly; it is written into the workspace under `uploads/` first, so
  every tool can read it afterwards.
- **Attach the file you're viewing** in the File panel with one click. That chip follows
  the file *you* opened by hand and drops away the moment the model's own output is on
  screen.
- **Rewind to a message** with the button in the bar under it (shown on hover, next to
  Edit). A confirmation lists what will change. Rewind removes that message and everything
  after it, restores workspace files to the moment it was sent, and puts its text back in
  the composer. A file changed outside the agent since then is listed and left as is. It is
  unavailable while a run, a sub-agent, or a compaction is active. If the message predates
  this feature, or the conversation now uses another folder, only the conversation is
  rewound.

Attachments are resolved when the message is actually sent, so an edit you make between
attaching and sending is picked up.

---

## Managing files in the Workspace tree

The Workspace panel lists the granted folder. Right-click any file or folder for a context
menu offering **New file**, **New folder**, **Rename**, and **Delete** (which asks for
confirmation inline). Creating acts in the target's own folder, its parent folder when the
target is a file, or the root when you right-click empty space. Drag an entry onto a folder
to move it there, or onto empty space to move it back to the root.

---

## Previewing files

The File panel opens whatever you select in the Workspace tree, a link in chat, or a URL
you paste into its address bar, and picks a viewer to match:

- **Text and code** with syntax highlighting, plus a source/preview toggle where it
  applies.
- **Markdown** as a rich preview or raw source.
- **JSON** as a collapsible tree or raw source.
- **Mermaid** diagrams from `.mmd` / `.mermaid` sources.
- **HTML**, rendered in an isolated frame.
- **CSV / XLSX** as a table, **DOCX** as a document.
- **Images, audio, and video** inline.

When the model writes an artifact it can ask the panel to open it for you automatically.

---

## Connecting MCP servers

The **MCP** rail panel connects the app to remote [Model Context Protocol](https://modelcontextprotocol.io)
servers. The browser talks to each server directly; there is no backend in between.

- **Transports.** Streamable HTTP and the legacy SSE transport. **Auto** tries Streamable HTTP
  first and falls back to SSE when the server does not offer it. Stdio servers cannot run in a
  browser: expose them over HTTP with a bridge you run yourself.
- **URLs.** `https://` anywhere, `http://` only for `localhost` and `127.0.0.1`. The production
  Content-Security-Policy blocks other plain-HTTP connections, so the form rejects them.
- **CORS.** The server must answer the browser's preflight. It needs to allow the headers
  `Authorization`, `Content-Type`, `Mcp-Session-Id`, `MCP-Protocol-Version`, and
  `Last-Event-ID`, and expose `Mcp-Session-Id` and `WWW-Authenticate`. When it does not,
  the panel says the server could not be reached and suggests a proxy.
- **Proxy URL.** Optional, per server. Every request — the MCP endpoint, OAuth discovery,
  registration, and token calls — is sent to the proxy URL followed by the full target URL
  (`https://proxy.example.com/https://mcp.example.com/mcp`). The proxy sees every request,
  including headers and tokens, so use one you run or trust.
- **Authentication.** None, static headers (for example `Authorization: Bearer …`), or
  OAuth 2.1 with PKCE. **Sign in** opens a pop-up; the server redirects back to
  `<app URL>?mcp-oauth=callback`, which hands the code to the app tab and closes. Without a
  client ID the app registers itself with the server (dynamic client registration); with a
  pre-registered client, allow that redirect URL. A server without a saved sign-in never
  opens a pop-up on its own: it waits in **sign in** until you click.
- **Tools.** Each enabled tool reaches the model as `mcp_<server>_<tool>`, shortened with a
  hash when it would exceed 64 characters. MCP tools run without a prompt in Editing and Full
  access, and ask for approval in Read-only. Save Ask or Deny per tool in **Approvals** to
  change that; a Deny blocks the tool in every mode. Removing, repointing, or renaming a
  server clears the decisions saved for its tools. Sub-agents can use them within their own mode. Toggle individual tools off in
  the MCP panel to keep a large server from crowding the tool list.
- **Prompts** become `/` commands named `<server>.<prompt>`. One argument takes the rest of
  the line; several take `name=value` pairs.
- **Resources** can be attached with `@` (type `@mcp` to list them) and read by the model with
  `list_mcp_resources` and `read_mcp_resource`, which do not ask for approval.
- **Lifecycle.** Enabled servers connect in the background after unlock. Locking the vault
  closes every connection.

## Running terminal commands

The app itself cannot start processes. A small companion, **`sagent-bridge`**, runs on your
machine and gives the model (and you) a real shell in your project folder. It supports macOS
and Linux, and needs Node 20 or newer.

**Set up.**

1. In your project folder, run `npx sagent-bridge@0.1.0 --root .`
2. The bridge prints a pairing link and copies it to the clipboard. Open it in your browser
   (pass `--open` to have the bridge open it for you).
3. Unlock the vault in that tab. The app connects on its own, and the **Terminal** rail panel
   shows `Connected · root: <folder>`.

The link carries a one-time code that works once and expires after 10 minutes. The bridge
answers it with a redirect that puts the access token in the URL fragment, and the app
strips the fragment from the address bar right away. The token lives only in the bridge's
memory and is new every time the bridge starts, so **after a restart** the panel shows
*needs pairing*: press Enter in the bridge terminal and open the new link. You can also
pair by hand in the Terminal panel with the address and a token.

The bridge only runs inside the folder you pass to `--root`, and the conversation's
workspace folder must be that same folder. It refuses `/`, your home folder and its parents
unless you pass `--allow-broad-root`. If you serve the app from somewhere other than
`http://localhost:5173`, pass `--app-url <that URL>`.

**The six tools.**

| Tool | What it does |
| --- | --- |
| `run_command` | Runs one command to completion and returns its exit code and output (default timeout 120 s, max 600 s). |
| `terminal_start` | Starts a long-running or interactive session: a dev server, a watcher, a REPL, or a shell. |
| `terminal_write` | Types into a session: text, keys like `ctrl-c` or `up`, then Enter. |
| `terminal_read` | Reads more output, from an offset. |
| `terminal_kill` | Stops a session and every process it started, including background jobs. |
| `terminal_list` | Lists the sessions this conversation started. |

Model commands run in `bash` without your profile, so your aliases and shell functions do
not apply. The model only sees and controls sessions its own conversation started. Your own
shells in the Terminal panel are invisible to it.

**When commands ask.**

| Mode | Safe command | Sensitive command | Saved Deny | Saved Ask | Saved Allow |
| --- | --- | --- | --- | --- | --- |
| Read-only | asks | asks | blocked | asks | runs |
| Editing | runs | asks | blocked | asks every call | runs, even when sensitive |
| Full access | runs | asks | blocked | asks every call | runs, even when sensitive |

The bridge parses each command with a bash grammar and marks it sensitive when it deletes
recursively or by force, uses `sudo`, pipes into a shell or interpreter (`curl … | sh`), runs
inline code (`bash -c`, `node -e`, `python -c`), force-pushes or rewrites git history,
publishes a package, opens a remote connection, uploads files, redirects output, uses command
substitution or variables, reads or writes outside the workspace, starts a nested shell,
defines aliases, traps or prompt hooks, detaches from the session (`setsid`, `tmux`), or
cannot be parsed. The prompt shows the command and the reason. In an interactive shell, each line the model submits
is checked as a whole, so splitting `rm -r` and `f` across two writes still asks, and history
keys (`up`), tab completion and other line-editing keys always ask. The model's shell keeps
no command history, and a write is refused if anything else was typed into the session
after it was checked. Anything typed into a running program other than `y`, `n`, `q` or an
empty line also asks.

If the bridge is not connected, or runs in a different folder than the conversation, every
command is refused with *Terminal unavailable* and nothing runs.

**Sub-agents** can use the terminal tools within their own mode. A sensitive command from a
sub-agent queues an Allow/Deny card in the Agents panel. When a sub-agent stops or finishes,
its sessions are killed. Deleting a conversation kills its sessions too.

**Locking the vault** closes the connection but leaves sessions running. After you unlock,
the app reconnects and the panel shows their output again. Stopping the bridge (Ctrl+C in its
terminal) kills every session.

**Rewinding or reverting** a conversation restores files but does not undo commands. The
rewind and revert previews list the commands the span ran.

**Troubleshooting.**

- *Bridge not running* — start it with the command the panel shows.
- *Start the bridge with --app-url …* — the bridge does not allow this page's origin.
- *Pairing expired* — the bridge restarted. Press Enter in its terminal and open the new link.
- *Allow local network access for this site* — Chrome blocked the connection to
  `127.0.0.1`. Allow it in the site settings.
- *Update the bridge* — the bridge speaks a different protocol version than the app.
- A command is refused with *different folder* — restart the bridge with `--root` pointing at
  the conversation's workspace folder.

## Your data and what leaves your machine

sagent-studio has **no server side**. Everything below happens in your browser.

- **Stored locally, encrypted.** Conversations, messages, provider configuration, and API
  keys are encrypted with AES-GCM 256 using a key derived from your password
  (PBKDF2-SHA256). The key lives only in memory while the app is unlocked.
- **Stored locally, in the clear.** The vault salt and key-derivation parameters are
  plaintext — they have to be readable before anything can be decrypted. They reveal
  nothing on their own.
- **Memories are encrypted like conversations.** Each memory is its own AES-GCM record. The
  memory index and the bodies flagged important go to your chat provider in every turn's system
  prompt. Other bodies go only when the model recalls them. A folder-scoped memory keeps that
  folder's handle in the clear, like every folder grant.
- **Locked when idle.** The vault locks after a period of inactivity (15 minutes by
  default) and on demand. Locking discards the in-memory key, so you need your password
  again.
- **Sent to your provider, and only your provider.** Prompt text, attachments, and tool
  results for a turn go to the model endpoint you configured. Conversation content is
  **not** sent anywhere else, except what the MCP servers you add receive (below). A
  data-egress notice in Settings keeps this from being a surprise.
- **MCP servers receive what you and the model send them.** A tool call sends its arguments,
  a `/` prompt sends its arguments, and reading or attaching a resource sends its URI to that
  server — and through its proxy, when you set one. Header secrets and OAuth tokens are
  stored encrypted in the vault and sent only to that server (or its proxy).
- **TypeSafe is called through a same-origin proxy.** TypeSafe sends no CORS headers, so a
  direct browser call is rejected at the preflight. The app calls `/typesafe`, which Vite
  proxies to `https://api.typesafe.ai` for dev and preview; a static deployment must proxy
  that path the same way (or you can set an explicit endpoint in the TypeSafe settings).
- **The document library egresses in two places.** Adding a document sends its chunk text
  to the embedding provider you selected. A retrieval sends the query and the shortlisted
  passages to that same provider and to TypeSafe, which answers the judgments that gate and
  verify the passages. The encrypted index itself never leaves the device: listing,
  reading, and the local vector scan work offline, while a new query embedding and every
  judgment require network access.
- **The PDF worker is a same-origin execution surface.** Text extraction runs in a pdf.js
  worker Vite emits as a same-origin asset. That worker does not inherit the document's
  Content-Security-Policy, has the page's network egress, and can open IndexedDB, so
  parsing an attacker-controlled PDF is a real attack surface. The vault key never enters
  the worker and only raw PDF bytes are posted to it, so the exposure is availability and
  egress, not key material; file size and extracted-text caps bound the work.
- **The terminal bridge gives the model your user's shell. It is not a sandbox.** A command
  runs with your permissions and can `cd` anywhere. The folder rule only stops the working
  directory from leaving your project. A program that daemonizes itself (for example
  `docker run -d` or `pm2 start`) outlives the session that started it.
- **Classification is a prompting aid, not a boundary.** A script the model writes into the
  workspace and then runs (`sh build.sh`, `pnpm test`) does not ask, and can do anything.
- **A saved Allow for a terminal tool turns its prompts off,** including for sensitive
  commands.
- **While a bridge is paired, workspace HTML previews run without same-origin access,** so a
  previewed page cannot reach the bridge connection. Sandbox workers cannot open sockets at
  all.
- **The bridge token stays on your machine.** It is stored in the encrypted vault, never
  shown to the model, and removed from command output before the model sees it.
- **Reachable over the network.** The app allows outbound `https:` connections because
  provider endpoints are arbitrary and configured by you. Scripts are locked down hard,
  and model-authored HTML renders in an isolated frame that cannot read app storage or the
  parent page.

> ⚠️ **The vault is intentionally hard.** There is no recovery key, no password reset, and
> no export. If you forget your password, your encrypted data is gone. This is a
> deliberate design choice, not a bug.

---

## Troubleshooting

**The workspace button does nothing / I can't pick a folder.**
You are likely in a non-Chromium browser or a non-secure context. Use recent Chrome or
Edge at `https://` or `http://localhost`.

**The app says the folder permission was lost.**
Folder grants do not survive every browser restart. Re-grant the folder when prompted;
your files are untouched.

**"Wrong password" that you're sure is right.**
The vault distinguishes a wrong password from a corrupted vault. If you see the recovery
screen instead, the stored data is damaged, and the app offers to start over by erasing
the local vault.

---

## For developers

The whole app is a static bundle. Deploy `dist/` to any static host, but serve it over
**HTTPS** so the vault and the local-folder features work.

```
src/
  vault/       encrypted local storage, unlock/recovery screens, idle lock
  ai/          provider registry, model clients, TypeSafe integration
  chat/        streaming engine, thread persistence, compaction, approvals
  tools/       tool registry and the built-in tools the model can call
  rag/         encrypted document library, ingest, vector index, Jev gate
  workspace/   file system access, search, patching, change journal
  sandbox/     JavaScript worker and Python (Pyodide) runners
  terminal/    bridge client, pairing, root binding, and command approval
  skills/      skill discovery and loading
  ui/          application shell, panels, composer, and file viewers
  session/     per-conversation state wiring
packages/
  sagent-bridge/  the local terminal bridge (published to npm)
plans/         design documents and implementation history
```

- The Content-Security-Policy is injected at build time (`vite.config.ts`). In dev it is
  intentionally omitted so hot reload works.
- **Do not deploy this publicly as an API-key proxy.** Keys live in the browser, so a
  public deployment should front the providers with your own server. See the comments in
  `vite.config.ts` for the reasoning.
- The test suite runs on Vitest with jsdom and `fake-indexeddb`; setup lives in
  `src/test-setup.ts`.
