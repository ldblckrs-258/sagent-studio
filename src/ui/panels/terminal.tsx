import {
  Check,
  ChevronRight,
  Copy,
  Plus,
  RotateCcw,
  Square,
  SquareTerminal,
  Terminal as TerminalIcon,
  Unplug,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SessionInfo } from "sagent-bridge/protocol";
import { DEFAULT_PORT } from "sagent-bridge/protocol";
import { SecretField } from "../../ai/secret-field";
import { useSession } from "../../session/session-context";
import { START_COMMAND } from "../../terminal/manager";
import { parseBridgeConfig } from "../../terminal/pairing";
import type {
  BridgeConfig,
  BridgeStatus,
  TerminalPort,
} from "../../terminal/types";
import type { BadgeTone } from "../primitives";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelSection,
} from "../primitives";
import {
  formatElapsed,
  ownerLabel,
  readSelection,
  rememberSelection,
  useBridgeView,
  useNow,
} from "../terminal/use-terminal";

const XtermView = lazy(() => import("../terminal/xterm-view"));

export interface TerminalControls extends TerminalPort {
  pair(config: BridgeConfig): Promise<boolean>;
  retry(): void;
  forget(): Promise<void>;
}

const STATUS_TONE: Record<BridgeStatus, BadgeTone> = {
  unpaired: "neutral",
  connecting: "neutral",
  ready: "positive",
  "needs-auth": "caution",
  error: "danger",
};

const STATUS_LABEL: Record<BridgeStatus, string> = {
  unpaired: "not paired",
  connecting: "connecting",
  ready: "connected",
  "needs-auth": "needs pairing",
  error: "error",
};

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <div className="term-island flex items-start gap-2 rounded-sm border border-term-rule bg-term-bg py-1 pr-1 pl-2">
      <code className="min-w-0 flex-1 py-1 font-mono text-xs leading-5 break-words text-term-ink">
        <span className="text-term-faint select-none">$ </span>
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy command"}
        onClick={copy}
        className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-term-muted transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:bg-term-surface hover:text-term-ink active:translate-y-px"
      >
        {copied ? (
          <Check
            size={14}
            strokeWidth={1.75}
            className="text-term-green"
            aria-hidden
          />
        ) : (
          <Copy size={14} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </div>
  );
}

function SetupStep({
  n,
  text,
  children,
}: {
  n: number;
  text: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-2">
      <span className="numeric w-3 shrink-0 font-mono text-xs leading-5 text-faint">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-xs leading-5 text-ink">{text}</p>
        {children}
      </div>
    </li>
  );
}

function SetupSteps() {
  return (
    <ol aria-label="Connect the bridge" className="flex flex-col gap-3">
      <SetupStep n={1} text="Start the bridge in your project folder.">
        <CommandLine command={START_COMMAND} />
      </SetupStep>
      <SetupStep
        n={2}
        text="Open the pairing link it prints. The bridge also copies it to your clipboard."
      />
      <SetupStep
        n={3}
        text="Unlock the vault in that tab. This panel connects on its own."
      />
    </ol>
  );
}

function StatusReason({ reason }: { reason: string }) {
  const suffix = `: ${START_COMMAND}`;
  if (!reason.endsWith(suffix))
    return (
      <p className="text-xs leading-relaxed break-words text-muted">{reason}</p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-muted">{`${reason.slice(0, -suffix.length)}. Run this in your project folder:`}</p>
      <CommandLine command={START_COMMAND} />
    </div>
  );
}

function Disclosure({
  label,
  count,
  open,
  onToggle,
  slot,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle(): void;
  slot?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot={slot}
      className="overflow-hidden rounded-sm border border-rule bg-surface"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted transition-colors duration-150 ease-out-quart hover:bg-paper-sunk hover:text-ink"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className={`shrink-0 transition-transform duration-200 ease-out-quart motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="flex-1 text-left">{label}</span>
        {count !== undefined ? (
          <span className="numeric font-mono text-faint">{count}</span>
        ) : null}
      </button>
      {open ? <div className="border-t border-rule p-2">{children}</div> : null}
    </div>
  );
}

function PairingForm({ terminal }: { terminal: TerminalControls }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(`ws://127.0.0.1:${DEFAULT_PORT}`);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const config = parseBridgeConfig(url, token);
    if (!config) {
      setError(
        "Use a ws:// address on 127.0.0.1, localhost or [::1], and the token the bridge printed.",
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (await terminal.pair(config)) {
        setToken("");
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Disclosure
      label="Pair manually"
      open={open}
      onToggle={() => setOpen((prev) => !prev)}
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Bridge address">
          <Input
            size="sm"
            name="bridge-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Token" error={error ?? undefined}>
          <SecretField
            name="bridge-token"
            storedValue={token}
            onChange={setToken}
            placeholder="Paste the token"
          />
        </Field>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={busy}
          className="self-start"
        >
          Connect
        </Button>
      </form>
    </Disclosure>
  );
}

function exitLabel(session: SessionInfo): string {
  return `exit ${session.exitCode ?? session.signal ?? "?"}`;
}

function exitFailed(session: SessionInfo): boolean {
  return !session.running && session.exitCode !== 0;
}

function SessionRow({
  session,
  selected,
  now,
  onSelect,
  onOpen,
  onKill,
}: {
  session: SessionInfo;
  selected: boolean;
  now: number;
  onSelect(): void;
  onOpen(): void;
  onKill(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const Icon = session.kind === "pty" ? TerminalIcon : SquareTerminal;
  const owner = ownerLabel(session);
  const needsConfirm = session.running && session.owner.source === "user";
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-session={session.id}
      title="Open in Terminal"
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        onSelect();
        onOpen();
      }}
      className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-sm py-1 px-2 text-xs transition-colors duration-150 ease-out-quart ${selected ? "bg-accent-soft text-ink" : "text-muted hover:bg-paper-sunk hover:text-ink"}`}
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={selected ? "shrink-0 text-accent" : "shrink-0 text-faint"}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate font-mono">
        {session.command ?? "shell"}
      </span>
      <span
        className={`max-w-24 shrink-0 truncate text-[10.5px] ${owner === "you" ? "text-faint" : "text-accent"}`}
      >
        {owner}
      </span>
      <span
        className={`numeric w-20 shrink-0 text-right font-mono text-[10.5px] ${exitFailed(session) ? "text-danger" : "text-faint"}`}
      >
        {session.running
          ? formatElapsed(now - session.startedAt)
          : exitLabel(session)}
      </span>
      {session.running ? (
        confirming ? (
          <span
            className="flex items-center gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              size="sm"
              variant="danger"
              onClick={onKill}
              className="min-h-5! py-0"
            >
              Kill
            </Button>
            <IconButton label="Cancel" onClick={() => setConfirming(false)}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </span>
        ) : (
          <span className="flex" onClick={(event) => event.stopPropagation()}>
            <IconButton
              tone="danger"
              label={`Kill ${session.command ?? "shell"}`}
              onClick={() => {
                if (needsConfirm) setConfirming(true);
                else onKill();
              }}
            >
              <Square size={10} strokeWidth={1.75} fill="currentColor" />
            </IconButton>
          </span>
        )
      ) : null}
    </div>
  );
}

function TerminalWindow({
  session,
  terminal,
}: {
  session: SessionInfo;
  terminal: TerminalControls;
}) {
  const Icon = session.kind === "pty" ? TerminalIcon : SquareTerminal;
  const failed = exitFailed(session);
  return (
    <section
      aria-label={`Terminal: ${session.command ?? "shell"}`}
      className="term-island flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border border-term-rule bg-term-bg"
    >
      <div className="flex items-center gap-2 border-b border-term-rule bg-term-surface px-2 py-1.5 font-mono text-[10.5px]">
        <Icon
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-term-faint"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-xs text-term-ink">
          {session.command ?? "shell"}
        </span>
        {session.cwd !== "." ? (
          <span className="max-w-24 shrink-0 truncate text-term-faint">
            {session.cwd}
          </span>
        ) : null}
        <span
          className={`shrink-0 ${session.running ? "text-term-green" : failed ? "text-term-red" : "text-term-muted"}`}
        >
          {session.running ? "running" : exitLabel(session)}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <p className="p-2 font-mono text-xs text-term-faint">
              Loading terminal…
            </p>
          }
        >
          <XtermView
            key={session.id}
            port={terminal}
            sessionId={session.id}
            running={session.running}
          />
        </Suspense>
      </div>
    </section>
  );
}

type PanelTab = "sessions" | "terminal";

const TABS: readonly PanelTab[] = ["sessions", "terminal"];
const TAB_LABEL: Record<PanelTab, string> = {
  sessions: "Sessions",
  terminal: "Terminal",
};

export function TerminalPanel() {
  const terminal = useSession().terminal as TerminalControls;
  const view = useBridgeView(terminal);
  const [tab, setTab] = useState<PanelTab>("sessions");
  const [selected, setSelected] = useState<string | null>(null);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = view.sessions;
  const live = sessions.filter((session) => session.running);
  const finished = sessions.filter((session) => !session.running);
  const now = useNow(1000, live.length > 0);
  const activeId =
    selected !== null && sessions.some((session) => session.id === selected)
      ? selected
      : readSelection([...live, ...finished]);
  const active = sessions.find((session) => session.id === activeId) ?? null;
  const ready = view.status === "ready";

  const select = (id: string) => {
    setSelected(id);
    rememberSelection(id);
  };

  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const newShell = () =>
    act(async () => {
      const info = await terminal.create({
        kind: "pty",
        shell: "user",
        owner: { source: "user" },
      });
      select(info.id);
      setTab("terminal");
    });

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const next =
      TABS[
        (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) %
          TABS.length
      ];
    setTab(next);
    event.currentTarget
      .querySelector<HTMLElement>(`[data-tab="${next}"]`)
      ?.focus();
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const ordered = [...live, ...(finishedOpen ? finished : [])];
    const index = ordered.findIndex((session) => session.id === activeId);
    const next = ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      select(next.id);
      event.currentTarget
        .querySelector<HTMLElement>(`[data-session="${next.id}"]`)
        ?.focus();
    }
  };

  const row = (session: SessionInfo) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={session.id === activeId}
      now={now}
      onSelect={() => select(session.id)}
      onOpen={() => setTab("terminal")}
      onKill={() => act(() => terminal.kill(session.id))}
    />
  );

  const newShellButton = (
    <Button
      size="sm"
      variant="quiet"
      icon={<Plus size={14} strokeWidth={1.75} />}
      onClick={newShell}
    >
      New shell
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Terminal"
        onKeyDown={onTabKey}
        className="flex shrink-0 items-center gap-0.5 border-b border-rule px-1.5 py-1"
      >
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            id={`terminal-tab-${entry}`}
            data-tab={entry}
            aria-selected={tab === entry}
            aria-controls={`terminal-tabpanel-${entry}`}
            tabIndex={tab === entry ? 0 : -1}
            onClick={() => setTab(entry)}
            className={`flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm transition-colors ${
              tab === entry
                ? "bg-accent-soft text-accent"
                : "text-muted hover:text-ink"
            }`}
          >
            {TAB_LABEL[entry]}
            {entry === "sessions" && ready && live.length > 0 ? (
              <span className="numeric font-mono text-xs text-faint">
                {live.length}
              </span>
            ) : null}
            {entry === "terminal" && active ? (
              <span className="max-w-28 truncate font-mono text-xs text-faint">
                {active.command ?? "shell"}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "sessions" ? (
        <div
          role="tabpanel"
          id="terminal-tabpanel-sessions"
          aria-labelledby="terminal-tab-sessions"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2"
        >
          <header
            aria-live="polite"
            data-slot="terminal-status"
            className="flex flex-col gap-1.5"
          >
            <div className="flex min-h-7 items-center gap-2">
              <Badge tone={STATUS_TONE[view.status]}>
                {STATUS_LABEL[view.status]}
              </Badge>
              {ready ? (
                <p className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono text-xs">
                  <span className="truncate text-ink" title="Workspace root">
                    {view.rootName ?? "?"}
                  </span>
                  <span className="numeric shrink-0 text-faint">
                    bridge {view.bridgeVersion ?? "?"}
                  </span>
                </p>
              ) : (
                <span className="flex-1" />
              )}
              {view.status === "error" || view.status === "needs-auth" ? (
                <IconButton label="Retry" onClick={() => terminal.retry()}>
                  <RotateCcw size={14} strokeWidth={1.75} />
                </IconButton>
              ) : null}
              {view.paired ? (
                <IconButton
                  label="Forget bridge"
                  tone="danger"
                  onClick={() => act(() => terminal.forget())}
                >
                  <Unplug size={14} strokeWidth={1.75} />
                </IconButton>
              ) : null}
            </div>
            {!ready && view.reason ? (
              <StatusReason reason={view.reason} />
            ) : null}
          </header>

          {view.status === "unpaired" || view.status === "needs-auth" ? (
            <>
              <SetupSteps />
              <PairingForm terminal={terminal} />
            </>
          ) : null}

          {ready ? (
            <PanelSection
              label="Sessions"
              count={live.length}
              action={newShellButton}
            >
              {sessions.length === 0 ? (
                <EmptyState
                  icon={<TerminalIcon size={16} strokeWidth={1.75} />}
                  title="No sessions yet."
                  hint="Open a shell, or let the model run a command."
                />
              ) : (
                <div
                  role="listbox"
                  aria-label="Terminal sessions"
                  onKeyDown={onListKey}
                  className="flex flex-col gap-2"
                >
                  {live.length > 0 ? (
                    <div className="flex flex-col gap-0.5">{live.map(row)}</div>
                  ) : null}
                  {finished.length > 0 ? (
                    <Disclosure
                      slot="finished-sessions"
                      label="Finished"
                      count={finished.length}
                      open={finishedOpen}
                      onToggle={() => setFinishedOpen((prev) => !prev)}
                    >
                      <div className="flex flex-col gap-0.5">
                        {finished.map(row)}
                      </div>
                    </Disclosure>
                  ) : null}
                </div>
              )}
            </PanelSection>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div
          role="tabpanel"
          id="terminal-tabpanel-terminal"
          aria-labelledby="terminal-tab-terminal"
          className="flex min-h-0 flex-1 flex-col p-2"
        >
          {ready && active ? (
            <TerminalWindow session={active} terminal={terminal} />
          ) : (
            <EmptyState
              icon={<TerminalIcon size={16} strokeWidth={1.75} />}
              title={
                ready ? "No session open." : "The bridge is not connected."
              }
              hint={
                ready
                  ? "Pick one in Sessions, or open a new shell."
                  : "Connect it in Sessions first."
              }
              action={ready ? newShellButton : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default TerminalPanel;
