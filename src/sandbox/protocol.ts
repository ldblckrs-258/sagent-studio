export type ToWorker =
  | { kind: 'run'; runId: string; language: 'js' | 'py'; source: string }
  | { kind: 'fs.result'; requestId: string; ok: true; data: string }
  | { kind: 'fs.error'; requestId: string; ok: false; message: string }

export type FromWorker =
  | {
      kind: 'result'
      runId: string
      stdout: string
      stderr: string
      result: string | null
      error?: string
      fatal?: boolean
    }
  | {
      kind: 'fs.call'
      runId: string
      requestId: string
      op: 'read' | 'write' | 'list'
      path: string
      data?: string
    }
  | { kind: 'fatal'; message: string }

export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SandboxError'
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(message = 'The sandbox run exceeded its time limit.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'SandboxTimeoutError'
  }
}

export class BridgeSerializationError extends SandboxError {
  constructor(message = 'The value cannot cross the sandbox bridge.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'BridgeSerializationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertSerializable(value: unknown, label = 'value'): void {
  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (depth > 64) throw new BridgeSerializationError(`${path} is nested too deeply.`)
    if (candidate === null) return

    const kind = typeof candidate
    if (kind === 'string' || kind === 'boolean') return
    if (kind === 'number') {
      if (!Number.isFinite(candidate as number)) {
        throw new BridgeSerializationError(`${path} is not a finite number.`)
      }
      return
    }
    if (kind === 'bigint' || kind === 'function' || kind === 'symbol') {
      throw new BridgeSerializationError(`${path} is a ${kind}.`)
    }
    if (kind === 'undefined') throw new BridgeSerializationError(`${path} is undefined.`)

    if (candidate instanceof Uint8Array) return
    if (typeof SharedArrayBuffer !== 'undefined' && candidate instanceof SharedArrayBuffer) {
      throw new BridgeSerializationError(`${path} is a SharedArrayBuffer.`)
    }
    if (candidate instanceof Map || candidate instanceof Set) {
      throw new BridgeSerializationError(`${path} is a ${candidate.constructor.name}.`)
    }
    if (candidate instanceof Blob || ArrayBuffer.isView(candidate)) {
      throw new BridgeSerializationError(`${path} is not a plain value.`)
    }
    if (candidate instanceof Error) {
      throw new BridgeSerializationError(`${path} is an Error instance.`)
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1))
      return
    }
    if (isRecord(candidate)) {
      const proto = Object.getPrototypeOf(candidate)
      if (proto !== Object.prototype && proto !== null) {
        throw new BridgeSerializationError(`${path} is a class instance.`)
      }
      for (const [key, nested] of Object.entries(candidate)) {
        visit(nested, `${path}.${key}`, depth + 1)
      }
      return
    }
    throw new BridgeSerializationError(`${path} is not serializable.`)
  }

  visit(value, label, 0)
}

export function parseInbound(raw: unknown): FromWorker | null {
  if (!isRecord(raw)) return null

  if (raw.kind === 'result') {
    if (typeof raw.runId !== 'string') return null
    if (typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string') return null
    if (raw.result !== null && typeof raw.result !== 'string') return null
    if (raw.error !== undefined && typeof raw.error !== 'string') return null
    if (raw.fatal !== undefined && typeof raw.fatal !== 'boolean') return null
    return {
      kind: 'result',
      runId: raw.runId,
      stdout: raw.stdout,
      stderr: raw.stderr,
      result: raw.result,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      ...(raw.fatal === true ? { fatal: true } : {}),
    }
  }

  if (raw.kind === 'fatal') {
    if (typeof raw.message !== 'string') return null
    return { kind: 'fatal', message: raw.message }
  }

  if (raw.kind === 'fs.call') {
    if (typeof raw.runId !== 'string' || typeof raw.requestId !== 'string') return null
    if (raw.op !== 'read' && raw.op !== 'write' && raw.op !== 'list') return null
    if (typeof raw.path !== 'string') return null
    if (raw.data !== undefined && typeof raw.data !== 'string') return null
    return {
      kind: 'fs.call',
      runId: raw.runId,
      requestId: raw.requestId,
      op: raw.op,
      path: raw.path,
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
    }
  }

  return null
}

export const MAX_OUTPUT_BYTES = 64 * 1024

export function truncateOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}
