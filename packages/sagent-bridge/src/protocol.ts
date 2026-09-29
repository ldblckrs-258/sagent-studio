export const PROTOCOL_VERSION = 1
export const BRIDGE_VERSION = '0.2.0'
export const SUBPROTOCOL = 'sagent-bridge.v1'
export const TOKEN_SUBPROTOCOL_PREFIX = 'sagent-token.'
export const DEFAULT_PORT = 7717
export const DEFAULT_APP_URL = 'https://sagent-studio.vercel.app'
export const PAIR_FRAGMENT_KEY = 'sagent-bridge'
export const PAIR_TOKEN_KEY = 'token'

export type SessionKind = 'exec' | 'pty'
export type ShellMode = 'model' | 'user'
export type OwnerSource = 'model' | 'user' | 'agent'
export type Capability = 'pty' | 'exec' | 'classify'
export type ReadFormat = 'raw' | 'plain'
export type InputOrigin = 'model' | 'user'

export const INPUT_KEYS = ['ctrl-c', 'ctrl-d', 'ctrl-z', 'enter', 'tab', 'esc', 'up', 'down'] as const
export type InputKey = (typeof INPUT_KEYS)[number]

export const KEY_SEQUENCES: Record<InputKey, string> = {
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
}

export function encodeInput(input: string | undefined, keys: readonly InputKey[] | undefined, submit: boolean): string {
  let data = input ?? ''
  for (const key of keys ?? []) data += KEY_SEQUENCES[key]
  if (submit) data += '\r'
  return data
}

export interface SessionOwner {
  source: OwnerSource
  threadId?: string
  runId?: string
}

export interface SessionInfo {
  id: string
  kind: SessionKind
  shell: ShellMode
  command: string | null
  cwd: string
  owner: SessionOwner
  running: boolean
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  startedAt: number
  nextOffset: number
  cols?: number
  rows?: number
}

export interface Classification {
  sensitive: boolean
  reasons: string[]
  commands: string[]
  inputVersion?: number
}

export interface ReadResult {
  data: string
  fromOffset: number
  nextOffset: number
  truncated: boolean
  running: boolean
  exitCode?: number | null
}

export interface KillResult {
  killed: boolean
  exitCode?: number | null
}

export interface KillOwnedResult {
  killed: string[]
}

export interface VerifyRootResult {
  matches: boolean
}

export interface HealthResponse {
  name: 'sagent-bridge'
  protocol: number
  allowed: boolean
  bridgeVersion?: string
  rootName?: string
}

export const ERROR_CODES = [
  'unauthorized',
  'bad_request',
  'cwd_outside_root',
  'session_not_found',
  'session_limit',
  'pty_unavailable',
  'timeout',
  'root_mismatch',
  'stale_input',
  'internal',
] as const
export type BridgeErrorCode = (typeof ERROR_CODES)[number]

export type ClientMessage =
  | { type: 'hello'; id: string; clientVersion: string }
  | {
      type: 'create'
      id: string
      kind: SessionKind
      command?: string
      cwd?: string
      cols?: number
      rows?: number
      timeoutMs?: number
      shell: ShellMode
      owner: SessionOwner
    }
  | { type: 'input'; id: string; session: string; data: string; origin: InputOrigin; expectVersion?: number }
  | { type: 'resize'; id: string; session: string; cols: number; rows: number }
  | { type: 'read'; id: string; session: string; sinceOffset?: number; maxBytes?: number; format: ReadFormat }
  | { type: 'attach'; id: string; session: string; sinceOffset?: number }
  | { type: 'detach'; id: string; session: string }
  | { type: 'kill'; id: string; session: string }
  | { type: 'killOwned'; id: string; threadId?: string; runId?: string }
  | { type: 'list'; id: string }
  | { type: 'classify'; id: string; command: string }
  | { type: 'classifyInput'; id: string; session: string; input?: string; keys?: InputKey[]; submit: boolean }
  | { type: 'verifyRoot'; id: string; nonce: string }

export type ClientMessageType = ClientMessage['type']

export type BridgeMessage =
  | {
      type: 'hello'
      protocol: number
      bridgeVersion: string
      platform: string
      rootName: string
      rootFingerprint: string
      capabilities: Capability[]
    }
  | { type: 'ok'; id: string; result: unknown }
  | { type: 'error'; id?: string; code: BridgeErrorCode; message: string }
  | { type: 'output'; session: string; data: string; offset: number }
  | { type: 'exit'; session: string; exitCode: number | null; signal?: string | null; timedOut?: boolean }
  | { type: 'sessions'; sessions: SessionInfo[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStr(value: unknown): value is string {
  return typeof value === 'string'
}

function isOptStr(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptNum(value: unknown): boolean {
  return value === undefined || isNum(value)
}

function isOptNonNegInt(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0)
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isOwner(value: unknown): value is SessionOwner {
  return (
    isObj(value) &&
    (value.source === 'model' || value.source === 'user' || value.source === 'agent') &&
    isOptStr(value.threadId) &&
    isOptStr(value.runId)
  )
}

function isKeys(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((key) => (INPUT_KEYS as readonly string[]).includes(key as string)))
  )
}

const CLIENT_VALIDATORS: Record<ClientMessageType, (m: Obj) => boolean> = {
  hello: (m) => isStr(m.clientVersion),
  create: (m) =>
    (m.kind === 'exec' || m.kind === 'pty') &&
    (m.shell === 'model' || m.shell === 'user') &&
    isOwner(m.owner) &&
    isOptStr(m.command) &&
    isOptStr(m.cwd) &&
    isOptNum(m.cols) &&
    isOptNum(m.rows) &&
    isOptNum(m.timeoutMs),
  input: (m) =>
    isSessionId(m.session) &&
    isStr(m.data) &&
    (m.origin === 'model' || m.origin === 'user') &&
    isOptNonNegInt(m.expectVersion),
  resize: (m) => isSessionId(m.session) && isNum(m.cols) && isNum(m.rows),
  read: (m) =>
    isSessionId(m.session) &&
    isOptNonNegInt(m.sinceOffset) &&
    isOptNonNegInt(m.maxBytes) &&
    (m.format === 'raw' || m.format === 'plain'),
  attach: (m) => isSessionId(m.session) && isOptNonNegInt(m.sinceOffset),
  detach: (m) => isSessionId(m.session),
  kill: (m) => isSessionId(m.session),
  killOwned: (m) => isOptStr(m.threadId) && isOptStr(m.runId) && (m.threadId !== undefined || m.runId !== undefined),
  list: () => true,
  classify: (m) => isStr(m.command),
  classifyInput: (m) => isSessionId(m.session) && isOptStr(m.input) && isKeys(m.keys) && isBool(m.submit),
  verifyRoot: (m) => isStr(m.nonce) && /^[A-Za-z0-9_-]{8,128}$/.test(m.nonce),
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isObj(value) || !isStr(value.type) || !isStr(value.id) || value.id.length === 0) return false
  if (!Object.hasOwn(CLIENT_VALIDATORS, value.type)) return false
  return CLIENT_VALIDATORS[value.type as ClientMessageType](value)
}

function isSessionInfo(value: unknown): value is SessionInfo {
  return (
    isObj(value) &&
    isSessionId(value.id) &&
    (value.kind === 'exec' || value.kind === 'pty') &&
    (value.shell === 'model' || value.shell === 'user') &&
    (value.command === null || isStr(value.command)) &&
    isStr(value.cwd) &&
    isOwner(value.owner) &&
    isBool(value.running) &&
    isNum(value.startedAt) &&
    isNum(value.nextOffset)
  )
}

type BridgeMessageType = BridgeMessage['type']

const BRIDGE_VALIDATORS: Record<BridgeMessageType, (m: Obj) => boolean> = {
  hello: (m) =>
    isNum(m.protocol) &&
    isStr(m.bridgeVersion) &&
    isStr(m.platform) &&
    isStr(m.rootName) &&
    isStr(m.rootFingerprint) &&
    Array.isArray(m.capabilities) &&
    m.capabilities.every((c) => c === 'pty' || c === 'exec' || c === 'classify'),
  ok: (m) => isStr(m.id),
  error: (m) =>
    isOptStr(m.id) && isStr(m.message) && (ERROR_CODES as readonly string[]).includes(m.code as string),
  output: (m) => isSessionId(m.session) && isStr(m.data) && isNum(m.offset),
  exit: (m) => isSessionId(m.session) && (m.exitCode === null || isNum(m.exitCode)),
  sessions: (m) => Array.isArray(m.sessions) && m.sessions.every(isSessionInfo),
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isObj(value) || !isStr(value.type) || !Object.hasOwn(BRIDGE_VALIDATORS, value.type)) return false
  return BRIDGE_VALIDATORS[value.type as BridgeMessageType](value)
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
