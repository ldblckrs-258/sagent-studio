import { lazy, Suspense, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Plus, RotateCcw, Skull, SquareTerminal, Terminal as TerminalIcon, X } from 'lucide-react'
import type { SessionInfo } from 'sagent-bridge/protocol'
import { DEFAULT_PORT } from 'sagent-bridge/protocol'
import { SecretField } from '../../ai/secret-field'
import { useSession } from '../../session/session-context'
import { START_COMMAND } from '../../terminal/manager'
import { parseBridgeConfig } from '../../terminal/pairing'
import type { BridgeConfig, BridgeStatus, TerminalPort } from '../../terminal/types'
import type { BadgeTone } from '../primitives'
import { Badge, Button, EmptyState, Field, IconButton, Input, PanelSection } from '../primitives'
import { formatElapsed, ownerLabel, readSelection, rememberSelection, useBridgeView, useNow } from '../terminal/use-terminal'

const XtermView = lazy(() => import('../terminal/xterm-view'))

export interface TerminalControls extends TerminalPort {
  pair(config: BridgeConfig): Promise<boolean>
  retry(): void
  forget(): Promise<void>
}

const STATUS_TONE: Record<BridgeStatus, BadgeTone> = {
  unpaired: 'neutral',
  connecting: 'neutral',
  ready: 'positive',
  'needs-auth': 'caution',
  error: 'danger',
}

const STATUS_LABEL: Record<BridgeStatus, string> = {
  unpaired: 'not paired',
  connecting: 'connecting',
  ready: 'connected',
  'needs-auth': 'needs pairing',
  error: 'error',
}

function PairingForm({ terminal }: { terminal: TerminalControls }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(`ws://127.0.0.1:${DEFAULT_PORT}`)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const config = parseBridgeConfig(url, token)
    if (!config) {
      setError('Use a ws:// address on 127.0.0.1, localhost or [::1], and the token the bridge printed.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      if (await terminal.pair(config)) {
        setToken('')
        setOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-muted">
        Run <code className="font-mono text-ink">{START_COMMAND}</code> and open the pairing link it prints (it is also copied to your clipboard).
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 self-start text-xs text-muted hover:text-ink"
      >
        <ChevronRight size={12} className={open ? 'rotate-90' : ''} aria-hidden />
        Pair manually
      </button>
      {open ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field label="Bridge address">
            <Input size="sm" name="bridge-url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <Field label="Token" error={error ?? undefined}>
            <SecretField name="bridge-token" storedValue={token} onChange={setToken} placeholder="Paste the token" />
          </Field>
          <Button size="sm" variant="primary" type="submit" disabled={busy}>
            Connect
          </Button>
        </form>
      ) : null}
    </div>
  )
}

function SessionRow({
  session,
  selected,
  now,
  onSelect,
  onKill,
}: {
  session: SessionInfo
  selected: boolean
  now: number
  onSelect(): void
  onKill(): void
}) {
  const [confirming, setConfirming] = useState(false)
  const Icon = session.kind === 'pty' ? TerminalIcon : SquareTerminal
  const owner = ownerLabel(session)
  const needsConfirm = session.running && session.owner.source === 'user'
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-session={session.id}
      onClick={onSelect}
      className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs ${selected ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-paper-sunk'}`}
    >
      <Icon size={13} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono">{session.command ?? 'shell'}</span>
      <Badge size="sm" tone={owner === 'you' ? 'neutral' : 'accent'}>
        {owner}
      </Badge>
      <span className="numeric shrink-0 font-mono text-[10px] text-faint">
        {session.running ? formatElapsed(now - session.startedAt) : `exit ${session.exitCode ?? session.signal ?? '?'}`}
      </span>
      {session.running ? (
        confirming ? (
          <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
            <Button size="sm" variant="danger" onClick={onKill}>
              Kill
            </Button>
            <IconButton label="Cancel" onClick={() => setConfirming(false)}>
              <X size={12} />
            </IconButton>
          </span>
        ) : (
          <IconButton
            label={`Kill ${session.command ?? 'shell'}`}
            onClick={() => {
              if (needsConfirm) setConfirming(true)
              else onKill()
            }}
          >
            <Skull size={12} />
          </IconButton>
        )
      ) : null}
    </div>
  )
}

export function TerminalPanel() {
  const terminal = useSession().terminal as TerminalControls
  const view = useBridgeView(terminal)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessions = view.sessions
  const live = sessions.filter((session) => session.running)
  const finished = sessions.filter((session) => !session.running)
  const now = useNow(1000, live.length > 0)
  const activeId =
    selected !== null && sessions.some((session) => session.id === selected) ? selected : readSelection([...live, ...finished])
  const active = sessions.find((session) => session.id === activeId) ?? null

  const select = (id: string) => {
    setSelected(id)
    rememberSelection(id)
  }

  const act = (run: () => Promise<unknown>) => {
    setError(null)
    run().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const newShell = () =>
    act(async () => {
      const info = await terminal.create({ kind: 'pty', shell: 'user', owner: { source: 'user' } })
      select(info.id)
    })

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const ordered = [...live, ...finished]
    const index = ordered.findIndex((session) => session.id === activeId)
    const next = ordered[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (next) {
      select(next.id)
      event.currentTarget.querySelector<HTMLElement>(`[data-session="${next.id}"]`)?.focus()
    }
  }

  const row = (session: SessionInfo) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={session.id === activeId}
      now={now}
      onSelect={() => select(session.id)}
      onKill={() => act(() => terminal.kill(session.id))}
    />
  )

  const statusText =
    view.status === 'ready'
      ? `Connected · root: ${view.rootName ?? '?'} · bridge ${view.bridgeVersion ?? '?'}`
      : (view.reason ?? STATUS_LABEL[view.status])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-2">
      <div className="flex items-start gap-2" aria-live="polite" data-slot="terminal-status">
        <Badge tone={STATUS_TONE[view.status]}>{STATUS_LABEL[view.status]}</Badge>
        <p className="min-w-0 flex-1 text-xs leading-relaxed break-words text-muted">{statusText}</p>
        {view.status === 'error' || view.status === 'needs-auth' ? (
          <IconButton label="Retry" onClick={() => terminal.retry()}>
            <RotateCcw size={12} />
          </IconButton>
        ) : null}
      </div>

      {view.status === 'unpaired' || view.status === 'needs-auth' ? <PairingForm terminal={terminal} /> : null}
      {view.paired ? (
        <Button size="sm" variant="quiet" className="self-start" onClick={() => act(() => terminal.forget())}>
          Forget bridge
        </Button>
      ) : null}

      {view.status === 'ready' ? (
        <PanelSection
          label="Sessions"
          count={live.length}
          action={
            <Button size="sm" variant="quiet" icon={<Plus size={12} />} onClick={newShell}>
              New shell
            </Button>
          }
        >
          {sessions.length === 0 ? (
            <EmptyState title="No sessions yet." hint="Open a shell, or let the model run a command." />
          ) : (
            <div role="listbox" aria-label="Terminal sessions" onKeyDown={onListKey} className="flex flex-col gap-0.5">
              {live.map(row)}
              {finished.length > 0 ? (
                <details data-slot="finished-sessions">
                  <summary className="cursor-pointer px-1 py-1 text-[10.5px] text-faint">
                    Finished ({finished.length})
                  </summary>
                  <div className="flex flex-col gap-0.5">{finished.map(row)}</div>
                </details>
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

      {view.status === 'ready' && active ? (
        <div className="min-h-64 flex-1 overflow-hidden rounded-sm border border-rule">
          <Suspense fallback={<p className="p-2 text-xs text-faint">Loading terminal…</p>}>
            <XtermView key={active.id} port={terminal} sessionId={active.id} running={active.running} />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}

export default TerminalPanel
