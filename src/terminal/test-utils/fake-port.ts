import type { Classification, SessionInfo } from 'sagent-bridge/protocol'
import type { BindResult, BridgeView, TerminalPort } from '../types'

export interface FakePortOptions {
  bind?: BindResult | (() => Promise<BindResult>)
  classify?: (command: string) => Classification | Promise<Classification>
  classifyInput?: (session: string, input: string | undefined) => Classification | Promise<Classification>
  sessions?: SessionInfo[]
}

const SAFE: Classification = { sensitive: false, reasons: [], commands: [] }

export function fakeSession(id: string, owner: SessionInfo['owner'], overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    kind: 'pty',
    shell: 'model',
    command: null,
    cwd: '.',
    owner,
    running: true,
    startedAt: 0,
    nextOffset: 0,
    ...overrides,
  }
}

export function createFakePort(options: FakePortOptions = {}): TerminalPort & {
  classified: string[]
  setEpoch(epoch: number): void
} {
  let epoch = 1
  const classified: string[] = []
  const view: BridgeView = { status: 'ready', capabilities: ['exec', 'pty', 'classify'], sessions: [], paired: true }
  const unsupported = () => Promise.reject(new Error('not supported by the fake port'))
  return {
    classified,
    setEpoch: (next) => {
      epoch = next
    },
    view: () => view,
    onChange: () => () => {},
    sessions: () => options.sessions ?? [],
    epoch: () => epoch,
    ensureBound: async () => {
      const bind = options.bind ?? { ok: true }
      return typeof bind === 'function' ? bind() : bind
    },
    classify: async (command) => {
      classified.push(command)
      return options.classify ? options.classify(command) : SAFE
    },
    classifyInput: async (session, input) => {
      classified.push(`${session}:${input ?? ''}`)
      return options.classifyInput ? options.classifyInput(session, input) : SAFE
    },
    create: unsupported,
    input: unsupported,
    resize: unsupported,
    read: unsupported,
    kill: unsupported,
    killOwned: async () => [],
    list: async () => options.sessions ?? [],
    subscribe: () => () => {},
    redact: (text) => text,
  }
}
