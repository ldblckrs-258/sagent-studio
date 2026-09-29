import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket as NodeWebSocket } from 'ws'
import type { SocketFactory, SocketLike } from '../client'

export const BRIDGE_CLI = fileURLToPath(new URL('../../../packages/sagent-bridge/dist/cli.js', import.meta.url))
export const TEST_APP_ORIGIN = 'http://localhost:5173'

export interface BridgeProcess {
  port: number
  url: string
  token: string
  root: string
  child: ChildProcess
  output(): string
  stop(): Promise<void>
}

export async function startBridge(options: { root: string; token?: string; port?: number }): Promise<BridgeProcess> {
  const token = options.token ?? randomBytes(24).toString('base64url')
  const child = spawn(
    process.execPath,
    [BRIDGE_CLI, '--root', options.root, '--port', String(options.port ?? 0), '--app-url', TEST_APP_ORIGIN],
    { env: { ...process.env, SAGENT_BRIDGE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${stdout}${stderr}`)), 15000)
    const check = () => {
      const match = /listen\s+ws:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout?.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited with ${code}: ${stdout}${stderr}`))
    })
  })
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    token,
    root: options.root,
    child,
    output: () => stdout + stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await exited
    },
  }
}

export function nodeSocketFactory(origin: string = TEST_APP_ORIGIN): SocketFactory {
  return (url, protocols) => new NodeWebSocket(url, protocols, { origin }) as unknown as SocketLike
}
