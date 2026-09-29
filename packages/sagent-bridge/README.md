# sagent-bridge

A local terminal bridge for sagent-studio. sagent-studio is a
browser app and cannot start processes. `sagent-bridge` runs on your machine, in one
project folder, and lets the app (and the model inside it) run shell commands, long-running
servers, and interactive sessions there over an authenticated WebSocket on `127.0.0.1`.

Supported platforms: **macOS and Linux**. Node **20** or newer. Windows exits with
"sagent-bridge supports macOS and Linux".

## Install and run

```sh
cd your-project
npx sagent-bridge@0.1.0 --root .
```

The bridge prints a pairing link. Open it in your browser, unlock the vault in that tab, and
the app connects. Pass `--open` to have the bridge open the link in your default browser. No build tools are needed: the terminal backend ships
prebuilt binaries and no install scripts run.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | required | The folder sessions run in. Commands may only start inside it. |
| `--port <n>` | `7717` | Port on `127.0.0.1`. If it is taken the bridge exits; it never picks another port. |
| `--app-url <url>` | `http://localhost:5173` | Where the app runs. Its origin (and the `localhost` ↔ `127.0.0.1` twin) may connect. |
| `--origin <url>` | none | Allow one more exact origin. Repeatable. Wildcards are rejected. |
| `--open` | off | Also open the pairing link in the default browser. |
| `--allow-broad-root` | off | Allow `/`, your home folder, or a parent of it as the root. |

## Pairing

- The printed link is `http://127.0.0.1:<port>/pair?code=<code>`. A code works **once** and
  expires after **10 minutes**. At most five codes are live at a time.
- When the bridge runs in a terminal, each new link is also copied to the clipboard (`pbcopy` on
  macOS; `wl-copy`, `xclip`, or `xsel` on Linux, whichever is installed).
- Press **Enter** in the bridge terminal to print a new link (and open it, with `--open`).
- Opening the link redirects to the app with the WebSocket address and the token in the URL
  fragment, which browsers never send to a server. The app removes it from the address bar,
  and saves the pairing in its encrypted vault only after the bridge accepts it.
- A used or expired link shows "Link expired. Press Enter in the sagent-bridge terminal for
  a new one."

## The token

The token is 32 random bytes, held **in memory only** and **new every time the bridge
starts**. It is never printed and never accepted on the command line. After a restart the
app shows "needs pairing" until you open a new link.

For automation and tests you can fix it with the `SAGENT_BRIDGE_TOKEN` environment variable
(16–256 characters of `A-Z a-z 0-9 _ -`). The token then lives in that environment, which
other processes of your user may be able to read.

## Chrome and hosted apps

- Chrome may ask to allow **local network access** the first time the page connects to
  `127.0.0.1`. Allow it, or the app reports "Allow local network access for this site".
- If you run the app from a hosted URL, start the bridge with `--app-url <that URL>`. A
  foreign origin gets `allowed: false` from `/health` and cannot open the socket.

## Root folder

`--root` is resolved to its real path. The bridge refuses `/`, your home folder, and any
parent of your home folder unless you pass `--allow-broad-root`, because every "outside the
workspace" rule would be meaningless there. A session's working directory must resolve
inside the root, symlinks included.

## Limits

- At most **16** running sessions.
- One-shot commands time out after 120 s by default, 600 s at most. Interactive sessions
  have no timeout.
- Each session keeps its last **1 MiB** of output for replay and reads.
- Input is limited to 8 KiB per message.
- Finished sessions are forgotten after 30 minutes.
- Stopping the bridge (Ctrl+C, SIGTERM) kills every session and every process each session
  started, including background jobs.

## Security model

- The server listens on `127.0.0.1` only. Every connection must pass three checks, in order:
  the `Host` header is a loopback name on the bridge port (this stops DNS rebinding), the
  `Origin` is on the allowlist (a missing origin is rejected), and the token, sent as a
  WebSocket subprotocol, matches in constant time.
- Commands the app asks for run in `bash --noprofile --norc` (interactive model shells also
  run with history off), with a small environment
  allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`). The token
  and every other variable are removed.
- The bridge classifies commands and interactive input with a bash grammar so the app can ask
  before sensitive ones run. **This is a prompting aid, not a sandbox.** A command runs as
  your user and can do anything you can, including reading files outside the root.
- The token is removed from anything the bridge sends.

## License

MIT
