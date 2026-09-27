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

`dev` and `build` both run a small pre-step that copies the Pyodide runtime out of
`node_modules` into `public/pyodide/`. That is normal.

---

## Choosing a permission mode

Each conversation runs in a mode that decides how much the model may do without asking:

| Mode | The model can… |
| --- | --- |
| **Read-only** | Read and search the workspace. Every change asks first. |
| **Editing** | Make changes, with an approval prompt for anything destructive. |
| **Full access** | Act autonomously, including writes and command execution. |

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
  conversation is idle. The conversation does not continue on its own.
- **Steer or force-stop a live run.** Select a run in the **Agents** panel to open its flow,
  send it a steering message it picks up at its next step, or force-stop it. A stopped run
  settles with the **stopped** status (reason `user_stop`) instead of a failure. The main
  model can do the same with the `stop_agent` tool, and read a run's most recent turns with
  `read_agent`.
- **In the transcript.** A `spawn_agent` call renders as a two-part card: the brief that was
  delegated, then the agent's returned text, with its tier and mode on the header and a tool
  call and token count on the result. A background run lands as its own sub-agent report card
  when it settles, carrying the agent's name, its outcome, and the returned text. The call's
  card also has an **Open in panel** action that jumps straight to that run in the Agents panel.
- **Mode is capped.** A sub-agent never runs above the conversation's own mode. In an
  *Editing* conversation, a request for *Full access* runs as *Editing*.
- **A subset of your tools.** A sub-agent can only use tools you already have, and never
  `spawn_agent`, `stop_agent`, `read_agent`, `change_mode`, `update_plan`, or `restore`.
  Delegation is one level deep.
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

## Using the composer

- **`/` slash commands** invoke skills and built-in actions.
- **`@` mentions** attach a workspace file by path.
- **Drag a file or folder** from the Workspace panel onto the input.
- **Upload** a file directly; it is written into the workspace under `uploads/` first, so
  every tool can read it afterwards.
- **Attach the file you're viewing** in the File panel with one click. That chip follows
  the file *you* opened by hand and drops away the moment the model's own output is on
  screen.

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

## Your data and what leaves your machine

sagent-studio has **no server side**. Everything below happens in your browser.

- **Stored locally, encrypted.** Conversations, messages, provider configuration, and API
  keys are encrypted with AES-GCM 256 using a key derived from your password
  (PBKDF2-SHA256). The key lives only in memory while the app is unlocked.
- **Stored locally, in the clear.** The vault salt and key-derivation parameters are
  plaintext — they have to be readable before anything can be decrypted. They reveal
  nothing on their own.
- **Locked when idle.** The vault locks after a period of inactivity (15 minutes by
  default) and on demand. Locking discards the in-memory key, so you need your password
  again.
- **Sent to your provider, and only your provider.** Prompt text, attachments, and tool
  results for a turn go to the model endpoint you configured. Conversation content is
  **not** sent anywhere else. A data-egress notice in Settings keeps this from being a
  surprise.
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
  skills/      skill discovery and loading
  ui/          application shell, panels, composer, and file viewers
  session/     per-conversation state wiring
plans/         design documents and implementation history
```

- The Content-Security-Policy is injected at build time (`vite.config.ts`). In dev it is
  intentionally omitted so hot reload works.
- **Do not deploy this publicly as an API-key proxy.** Keys live in the browser, so a
  public deployment should front the providers with your own server. See the comments in
  `vite.config.ts` for the reasoning.
- The test suite runs on Vitest with jsdom and `fake-indexeddb`; setup lives in
  `src/test-setup.ts`.
