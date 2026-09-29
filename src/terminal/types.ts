import type {
  BridgeErrorCode,
  Capability,
  Classification,
  InputKey,
  InputOrigin,
  KillResult,
  ReadFormat,
  ReadResult,
  SessionInfo,
  SessionKind,
  SessionOwner,
  ShellMode,
} from 'sagent-bridge/protocol'

export type BridgeStatus = 'unpaired' | 'connecting' | 'ready' | 'needs-auth' | 'error'

export interface BridgeConfig {
  url: string
  token: string
}

export interface BridgeView {
  status: BridgeStatus
  reason?: string
  bridgeVersion?: string
  rootName?: string
  platform?: string
  capabilities: Capability[]
  sessions: SessionInfo[]
  paired: boolean
}

export type TerminalErrorCode = BridgeErrorCode | 'unavailable' | 'permission_denied' | 'no_workspace'

export class TerminalError extends Error {
  readonly code: TerminalErrorCode

  constructor(code: TerminalErrorCode, message: string) {
    super(message)
    this.name = 'TerminalError'
    this.code = code
  }
}

export type BindResult =
  | { ok: true }
  | { ok: false; code: 'unavailable' | 'permission_denied' | 'root_mismatch' | 'no_workspace'; message: string }

export interface CreateSessionRequest {
  kind: SessionKind
  command?: string
  cwd?: string
  cols?: number
  rows?: number
  timeoutMs?: number
  shell: ShellMode
  owner: SessionOwner
}

export interface ReadRequest {
  sinceOffset?: number
  maxBytes?: number
  format: ReadFormat
}

export type OutputListener = (bytes: Uint8Array, offset: number) => void

export interface TerminalPort {
  view(): BridgeView
  onChange(listener: () => void): () => void
  sessions(): SessionInfo[]
  epoch(): number
  ensureBound(threadId: string): Promise<BindResult>
  create(request: CreateSessionRequest): Promise<SessionInfo>
  input(session: string, data: string, origin: InputOrigin, expectVersion?: number): Promise<void>
  resize(session: string, cols: number, rows: number): Promise<void>
  read(session: string, request: ReadRequest): Promise<ReadResult>
  kill(session: string): Promise<KillResult>
  killOwned(filter: { threadId?: string; runId?: string }): Promise<string[]>
  list(): Promise<SessionInfo[]>
  classify(command: string): Promise<Classification>
  classifyInput(session: string, input: string | undefined, keys: InputKey[] | undefined, submit: boolean): Promise<Classification>
  subscribe(session: string, onOutput: OutputListener, sinceOffset?: number): () => void
  redact(text: string): string
}

export interface TerminalScope {
  port: TerminalPort
  threadId: string
  runId?: string
}
