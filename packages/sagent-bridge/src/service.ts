import { homedir } from 'node:os'
import { classifierReady, classify, initClassifier } from './classify.js'
import type { BridgeConfig } from './config.js'
import { cleanupProbes, verifyRoot } from './probe.js'
import type { Capability, SessionInfo } from './protocol.js'
import { loadPty, type PtyModule } from './pty.js'
import type { BridgeServer, HandlerFactory, RequestHandler } from './server.js'
import { SessionManager } from './sessions.js'

export interface BridgeRuntimeOptions {
  pty?: PtyModule | null
  env?: NodeJS.ProcessEnv
  home?: string
  reapMs?: number
}

export interface BridgeRuntime {
  createHandler: HandlerFactory
  killAllSync(): void
}

export async function prepareBridge(config: BridgeConfig, options: BridgeRuntimeOptions = {}): Promise<BridgeRuntime> {
  const [pty] = await Promise.all([
    options.pty === undefined ? loadPty() : Promise.resolve(options.pty),
    initClassifier(),
    cleanupProbes(config.root),
  ])
  let managerRef: SessionManager | null = null

  const createHandler = (server: Pick<BridgeServer, 'broadcast'>): RequestHandler => {
    const sessionsMessage = (sessions: SessionInfo[]) => ({ type: 'sessions' as const, sessions })
    const manager = new SessionManager({
      root: config.root,
      home: options.home ?? homedir(),
      env: options.env ?? process.env,
      pty,
      reapMs: options.reapMs,
      events: {
        output: (session, chunk, offset) =>
          server.broadcast({ type: 'output', session, data: chunk.toString('base64'), offset }, (client) =>
            client.attached.has(session),
          ),
        exit: (info) =>
          server.broadcast({
            type: 'exit',
            session: info.id,
            exitCode: info.exitCode ?? null,
            signal: info.signal ?? null,
            timedOut: info.timedOut,
          }),
        changed: () => server.broadcast(sessionsMessage(manager.list())),
      },
    })
    managerRef = manager
    const classifyContext = { root: config.root, home: options.home ?? homedir() }

    return {
      capabilities: (): Capability[] => [
        'exec',
        ...(manager.ptyAvailable ? (['pty'] as const) : []),
        ...(classifierReady() ? (['classify'] as const) : []),
      ],
      handle: async (client, message) => {
        switch (message.type) {
          case 'create': {
            const info = await manager.create(message)
            client.attached.add(info.id)
            return info
          }
          case 'input':
            manager.input(message.session, message.data, message.origin, message.expectVersion)
            return {}
          case 'resize':
            manager.resize(message.session, message.cols, message.rows)
            return {}
          case 'read':
            return manager.read(message.session, message.sinceOffset, message.maxBytes, message.format)
          case 'attach': {
            const replay = manager.read(message.session, message.sinceOffset ?? 0, 1024 * 1024, 'raw')
            client.attached.add(message.session)
            return replay
          }
          case 'detach':
            client.attached.delete(message.session)
            return {}
          case 'kill':
            return manager.kill(message.session)
          case 'killOwned':
            return { killed: await manager.killOwned({ threadId: message.threadId, runId: message.runId }) }
          case 'list':
            return { sessions: manager.list() }
          case 'classify':
            return classify(message.command, classifyContext)
          case 'classifyInput':
            return manager.classifyInput(message.session, message.input, message.keys, message.submit)
          case 'verifyRoot':
            return verifyRoot(config.root, message.nonce)
        }
      },
      clientClosed: () => {},
      shutdown: () => manager.shutdown(),
    }
  }

  return {
    createHandler,
    killAllSync: () => managerRef?.killAllSync(),
  }
}
