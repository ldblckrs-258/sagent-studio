import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { basename } from 'node:path'
import { classify, type ClassifyContext } from './classify.js'
import { displayCwd, resolveCwd, sessionEnv } from './confine.js'
import { BridgeError } from './errors.js'
import { killSessionTree, killSessionTreeSync, ttyOf, type KillTarget } from './kill.js'
import { LineTracker, isPlainAnswer } from './line-tracker.js'
import { toPlain } from './plain.js'
import {
  encodeInput,
  type Classification,
  type ClientMessage,
  type InputKey,
  type InputOrigin,
  type KillResult,
  type ReadFormat,
  type ReadResult,
  type SessionInfo,
} from './protocol.js'
import type { IPty, PtyModule } from './pty.js'
import { RingBuffer } from './ring-buffer.js'

export const MAX_LIVE_SESSIONS = 16
export const MAX_INPUT_BYTES = 8 * 1024
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000
export const MAX_EXEC_TIMEOUT_MS = 600_000
export const DEFAULT_READ_BYTES = 64 * 1024
export const REAP_AFTER_MS = 30 * 60 * 1000
const MODEL_BASH = '/bin/bash'
const MODEL_BASH_ARGS = ['--noprofile', '--norc']

export type CreateRequest = Extract<ClientMessage, { type: 'create' }>

export interface SessionEvents {
  output(session: string, chunk: Buffer, offset: number): void
  exit(info: SessionInfo): void
  changed(): void
}

export interface SessionManagerOptions {
  root: string
  home: string
  env: NodeJS.ProcessEnv
  pty: PtyModule | null
  events: SessionEvents
  reapMs?: number
}

interface Session {
  info: SessionInfo
  ring: RingBuffer
  pid: number
  tty?: string
  pty?: IPty
  child?: ChildProcess
  tracker?: LineTracker
  interactiveShell: boolean
  exited: Promise<void>
  timer?: NodeJS.Timeout
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(constants.signals).map(([name, number]) => [number as number, name]),
)

function clampSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(500, Math.max(2, Math.round(value)))
}

function userShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL
  if (!shell) return '/bin/sh'
  try {
    const shells = readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
    return shells.includes(shell) ? shell : '/bin/sh'
  } catch {
    return '/bin/sh'
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly options: SessionManagerOptions
  private readonly classifyContext: ClassifyContext

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.classifyContext = { root: options.root, home: options.home }
  }

  get ptyAvailable(): boolean {
    return this.options.pty !== null
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info, owner: { ...session.info.owner } }))
  }

  private liveCount(): number {
    let count = 0
    for (const session of this.sessions.values()) if (session.info.running) count++
    return count
  }

  private get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new BridgeError('session_not_found', `No session ${id}`)
    return session
  }

  async create(request: CreateRequest): Promise<SessionInfo> {
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
      throw new BridgeError('session_limit', `At most ${MAX_LIVE_SESSIONS} sessions can run at once`)
    }
    const cwd = await resolveCwd(this.options.root, request.cwd)
    const command = request.command?.trim() ? request.command : undefined
    const id = randomUUID()
    const info: SessionInfo = {
      id,
      kind: request.kind,
      shell: request.shell,
      command: command ?? null,
      cwd: displayCwd(this.options.root, cwd),
      owner: { ...request.owner },
      running: true,
      startedAt: Date.now(),
      nextOffset: 0,
    }
    const ring = new RingBuffer()
    let resolveExited!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })

    const onOutput = (chunk: Buffer): void => {
      const offset = ring.append(chunk)
      info.nextOffset = ring.endOffset
      this.options.events.output(id, chunk, offset)
    }

    let session: Session
    if (request.kind === 'exec') {
      if (!command) throw new BridgeError('bad_request', 'exec sessions need a command')
      const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1000), MAX_EXEC_TIMEOUT_MS)
      const child = spawn(MODEL_BASH, [...MODEL_BASH_ARGS, '-c', `exec 2>&1\n${command}`], {
        cwd,
        env: sessionEnv(this.options.env),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (child.pid === undefined) throw new BridgeError('internal', 'Failed to start the command')
      child.stdout?.on('data', onOutput)
      child.stderr?.on('data', onOutput)
      session = { info, ring, pid: child.pid, child, interactiveShell: false, exited }
      child.on('exit', () => {
        void killSessionTree(this.target(session))
      })
      child.on('close', (code, signal) => {
        this.finish(session, code, signal)
        resolveExited()
      })
      child.on('error', () => {
        this.finish(session, null, null)
        resolveExited()
      })
      session.timer = setTimeout(() => {
        info.timedOut = true
        void this.kill(id)
      }, timeoutMs)
    } else {
      const pty = this.options.pty
      if (!pty) throw new BridgeError('pty_unavailable', 'Interactive terminals are unavailable on this machine')
      const cols = clampSize(request.cols, 120)
      const rows = clampSize(request.rows, 30)
      const model = request.shell === 'model'
      const file = model ? MODEL_BASH : userShell(this.options.env)
      const args = model
        ? command
          ? [...MODEL_BASH_ARGS, '-c', command]
          : [...MODEL_BASH_ARGS, '+H', '+o', 'history', '-l', '-O', 'huponexit', '-i']
        : command
          ? ['-l', '-c', command]
          : ['-l']
      const env = sessionEnv(this.options.env)
      if (model) {
        env.HISTFILE = ''
        env.HISTSIZE = '0'
        env.BASH_SILENCE_DEPRECATION_WARNING = '1'
        env.PS1 = '$ '
      }
      const term = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env, encoding: null })
      info.cols = cols
      info.rows = rows
      session = {
        info,
        ring,
        pid: term.pid,
        pty: term,
        tracker: model ? new LineTracker() : undefined,
        interactiveShell: model && !command,
        exited,
      }
      term.onData((data) => onOutput(typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Buffer)))
      void ttyOf(term.pid).then((tty) => {
        session.tty = tty
      })
      term.onExit(({ exitCode, signal }) => {
        void killSessionTree(this.target(session))
        this.finish(session, signal ? null : exitCode, signal ? (SIGNAL_NAMES.get(signal) ?? String(signal)) : null)
        resolveExited()
      })
    }
    this.sessions.set(id, session)
    this.options.events.changed()
    return { ...info, owner: { ...info.owner } }
  }

  private target(session: Session): KillTarget {
    return { sid: session.pid, tty: session.tty }
  }

  private finish(session: Session, code: number | null, signal: NodeJS.Signals | string | null): void {
    if (!session.info.running) return
    if (session.timer) clearTimeout(session.timer)
    session.info.running = false
    session.info.exitCode = code
    session.info.signal = signal
    const reap = setTimeout(() => {
      this.sessions.delete(session.info.id)
      this.options.events.changed()
    }, this.options.reapMs ?? REAP_AFTER_MS)
    reap.unref()
    this.options.events.exit({ ...session.info })
    this.options.events.changed()
  }

  input(id: string, data: string, origin: InputOrigin, expectVersion?: number): void {
    const session = this.get(id)
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
      throw new BridgeError('bad_request', `Input is limited to ${MAX_INPUT_BYTES} bytes per message`)
    }
    if (!session.pty) throw new BridgeError('bad_request', 'This session does not accept input')
    if (!session.info.running) throw new BridgeError('bad_request', 'The session has exited')
    if (session.tracker && origin === 'model' && expectVersion !== session.tracker.inputVersion) {
      throw new BridgeError('stale_input', 'The session received other input after this write was checked')
    }
    session.tracker?.apply(data, origin)
    session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id)
    if (!session.pty || !session.info.running) return
    session.info.cols = clampSize(cols, session.info.cols ?? 120)
    session.info.rows = clampSize(rows, session.info.rows ?? 30)
    session.pty.resize(session.info.cols, session.info.rows)
  }

  read(id: string, sinceOffset: number | undefined, maxBytes: number | undefined, format: ReadFormat): ReadResult {
    const session = this.get(id)
    const slice = session.ring.read(sinceOffset, Math.min(maxBytes ?? DEFAULT_READ_BYTES, 1024 * 1024))
    const midStream = slice.fromOffset > 0 && (sinceOffset === undefined || slice.fromOffset !== sinceOffset)
    return {
      data: format === 'plain' ? toPlain(slice.bytes, midStream) : slice.bytes.toString('base64'),
      fromOffset: slice.fromOffset,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      running: session.info.running,
      exitCode: session.info.exitCode,
    }
  }

  async kill(id: string): Promise<KillResult> {
    const session = this.get(id)
    if (!session.info.running) return { killed: false, exitCode: session.info.exitCode }
    await killSessionTree(this.target(session))
    await Promise.race([session.exited, new Promise((resolve) => setTimeout(resolve, 2000))])
    return { killed: true, exitCode: session.info.exitCode }
  }

  async killOwned(filter: { threadId?: string; runId?: string }): Promise<string[]> {
    const targets = [...this.sessions.values()].filter(
      (session) =>
        session.info.running &&
        ((filter.threadId !== undefined && session.info.owner.threadId === filter.threadId) ||
          (filter.runId !== undefined && session.info.owner.runId === filter.runId)),
    )
    await Promise.all(targets.map((session) => this.kill(session.info.id)))
    return targets.map((session) => session.info.id)
  }

  classifyInput(id: string, input: string | undefined, keys: InputKey[] | undefined, submit: boolean): Classification {
    const session = this.get(id)
    if (!session.pty || !session.info.running) {
      return { sensitive: true, reasons: ['session does not accept input'], commands: [] }
    }
    const tracker = session.tracker ?? new LineTracker()
    const inputVersion = tracker.inputVersion
    const { submitted } = tracker.simulate(encodeInput(input, keys, submit))
    if (submitted.length === 0) return { sensitive: false, reasons: [], commands: [], inputVersion }
    const foreground = basename(session.pty.process ?? '').replace(/^-/, '')
    const ownShell = session.interactiveShell && foreground === 'bash'
    const reasons = new Set<string>()
    const commands = new Set<string>()
    submitted.forEach((line, index) => {
      if (ownShell && index === 0) {
        if (line.opaque) {
          reasons.add('history or completion')
          return
        }
        const result = classify(line.line, this.classifyContext)
        for (const reason of result.reasons) reasons.add(reason)
        for (const command of result.commands) commands.add(command)
        return
      }
      if (!isPlainAnswer(line)) reasons.add(`input to ${ownShell ? 'a running program' : foreground || 'program'}`)
    })
    return { sensitive: reasons.size > 0, reasons: [...reasons], commands: [...commands], inputVersion }
  }

  async shutdown(): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.info.running)
    await Promise.all(running.map((session) => this.kill(session.info.id).catch(() => undefined)))
  }

  killAllSync(): void {
    for (const session of this.sessions.values()) {
      if (session.info.running) killSessionTreeSync(this.target(session))
    }
  }
}
