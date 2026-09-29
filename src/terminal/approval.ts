import { INPUT_KEYS, type Classification, type InputKey } from 'sagent-bridge/protocol'
import type { ChatMode } from '../chat/types'
import { persistedDecision, resolveApprovalStatus } from '../tools/approval'
import type { ApprovalSettings } from '../vault/settings'
import type { TerminalPort } from './types'

export const BIND_TIMEOUT_MS = 5000

export interface CommandApprovalContext {
  threadId: string
  runId?: string
  mode: ChatMode
  settings: ApprovalSettings | undefined
}

export type CommandApprovalResult =
  | { type: 'approved'; reason?: string }
  | { type: 'denied'; reason: string }
  | { type: 'user-approval'; reason?: string }

export interface CommandToolInput {
  command?: string
  cwd?: string
  session?: string
  input?: string
  keys?: InputKey[]
  submit?: boolean
}

interface LedgerEntry {
  name: string
  fingerprint: string
  epoch: number
  inputVersion?: number
}

export interface ApprovedCall {
  inputVersion?: number
}

const ledgers = new WeakMap<TerminalPort, Map<string, LedgerEntry>>()
const MAX_LEDGER_ENTRIES = 256

function ledgerOf(port: TerminalPort): Map<string, LedgerEntry> {
  let ledger = ledgers.get(port)
  if (!ledger) {
    ledger = new Map()
    ledgers.set(port, ledger)
  }
  return ledger
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function recordApproval(
  port: TerminalPort,
  toolCallId: string,
  name: string,
  input: unknown,
  inputVersion?: number,
): void {
  const ledger = ledgerOf(port)
  ledger.delete(toolCallId)
  ledger.set(toolCallId, {
    name,
    fingerprint: stableStringify(input),
    epoch: port.epoch(),
    ...(inputVersion !== undefined ? { inputVersion } : {}),
  })
  while (ledger.size > MAX_LEDGER_ENTRIES) ledger.delete(ledger.keys().next().value as string)
}

export function consumeApproval(
  port: TerminalPort,
  toolCallId: string,
  name: string,
  input: unknown,
): ApprovedCall | false {
  const ledger = ledgerOf(port)
  const entry = ledger.get(toolCallId)
  ledger.delete(toolCallId)
  if (!entry) return false
  if (entry.name !== name || entry.fingerprint !== stableStringify(input) || entry.epoch !== port.epoch()) return false
  return entry.inputVersion !== undefined ? { inputVersion: entry.inputVersion } : {}
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function readInput(value: unknown): CommandToolInput {
  if (typeof value !== 'object' || value === null) return {}
  const raw = value as Record<string, unknown>
  const keys = Array.isArray(raw.keys)
    ? raw.keys.filter((key): key is InputKey => (INPUT_KEYS as readonly string[]).includes(key as string))
    : undefined
  return {
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
    ...(typeof raw.input === 'string' ? { input: raw.input } : {}),
    ...(keys ? { keys } : {}),
    ...(typeof raw.submit === 'boolean' ? { submit: raw.submit } : {}),
  }
}

export function ownsSession(port: TerminalPort, sessionId: string, threadId: string): boolean {
  const session = port.sessions().find((s) => s.id === sessionId)
  return session !== undefined && session.owner.source !== 'user' && session.owner.threadId === threadId
}

async function classifyCall(
  port: TerminalPort,
  ctx: CommandApprovalContext,
  name: string,
  input: CommandToolInput,
): Promise<Classification | CommandApprovalResult> {
  if (name === 'terminal_write') {
    if (!input.session || !ownsSession(port, input.session, ctx.threadId)) {
      return { type: 'denied', reason: 'Not your session: terminal_write only reaches sessions this conversation started.' }
    }
    return port.classifyInput(input.session, input.input, input.keys, input.submit ?? true)
  }
  const command = input.command?.trim() ?? ''
  if (name === 'terminal_start' && command === '') return { sensitive: false, reasons: [], commands: [] }
  return port.classify(command)
}

export async function commandApprovalFor(
  port: TerminalPort,
  ctx: CommandApprovalContext,
  name: string,
  rawInput: unknown,
  toolCallId: string,
): Promise<CommandApprovalResult> {
  const base = resolveApprovalStatus(ctx.mode, ctx.settings, { name })
  if (base === 'denied') return { type: 'denied', reason: 'Denied by your saved approval policy.' }

  const unavailable = (message: string): CommandApprovalResult => ({
    type: 'denied',
    reason: `Terminal unavailable: ${message}`,
  })
  let bound
  try {
    bound = await withTimeout(port.ensureBound(ctx.threadId), BIND_TIMEOUT_MS, () => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: 'the bridge did not answer in time.',
    }))
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
  if (!bound.ok) return unavailable(bound.message)

  const approve = (result: CommandApprovalResult, inputVersion?: number): CommandApprovalResult => {
    if (result.type !== 'denied') recordApproval(port, toolCallId, name, rawInput, inputVersion)
    return result
  }

  let classification: Classification | CommandApprovalResult
  try {
    classification = await classifyCall(port, ctx, name, readInput(rawInput))
  } catch {
    return approve({ type: 'user-approval', reason: 'Could not classify command' })
  }
  if ('type' in classification) return approve(classification)
  const version = classification.inputVersion
  if (persistedDecision(ctx.settings, name) === 'allow') return approve({ type: 'approved' }, version)
  if (classification.sensitive) {
    return approve({ type: 'user-approval', reason: `Sensitive: ${classification.reasons.join(', ')}` }, version)
  }
  return approve(base === 'approved' ? { type: 'approved' } : { type: 'user-approval' }, version)
}

export const LANE_REASON = 'Runs after an earlier command awaiting approval'

export function createCommandLane() {
  let chain: Promise<unknown> = Promise.resolve()
  let stepKey: unknown = undefined
  let waiting = false

  return function inLane(step: unknown, decide: () => Promise<CommandApprovalResult>): Promise<CommandApprovalResult> {
    const run = chain.then(async (): Promise<CommandApprovalResult> => {
      if (step !== stepKey) {
        stepKey = step
        waiting = false
      }
      const result = await decide()
      if (result.type === 'denied') return result
      if (waiting) return { type: 'user-approval', reason: LANE_REASON }
      if (result.type === 'user-approval') waiting = true
      return result
    })
    chain = run.catch(() => undefined)
    return run
  }
}

export function describeCommandInput(toolName: string, input: unknown): string | null {
  const parsed = readInput(input)
  if (toolName === 'run_command' || toolName === 'terminal_start') {
    const command = parsed.command?.trim() ? `$ ${parsed.command}` : '$ (interactive bash shell)'
    return parsed.cwd ? `${command}\n  in ${parsed.cwd}` : command
  }
  if (toolName === 'terminal_write') {
    const parts: string[] = []
    if (parsed.input !== undefined) parts.push(JSON.stringify(parsed.input))
    if (parsed.keys?.length) parts.push(`[${parsed.keys.join(' ')}]`)
    if (parsed.submit ?? true) parts.push('⏎')
    return `→ session ${parsed.session?.slice(0, 8) ?? '?'}: ${parts.join(' ')}`
  }
  return null
}
