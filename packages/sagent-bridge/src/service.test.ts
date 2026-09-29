import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BridgeMessage, SessionInfo } from './protocol.js'
import { startServer, type BridgeServer } from './server.js'
import { prepareBridge } from './service.js'
import { openHelloedSocket, openSocket, testConfig } from './test-helpers.js'

let root: string
let server: BridgeServer | undefined

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-service-')))
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function start(): Promise<BridgeServer> {
  const config = testConfig(root)
  const runtime = await prepareBridge(config)
  server = await startServer(config, runtime.createHandler)
  return server
}

function result<T>(message: BridgeMessage): T {
  if (message.type !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(message)}`)
  return message.result as T
}

describe('bridge service over the socket', () => {
  it('advertises pty, exec and classify', async () => {
    const { port } = await start()
    const socket = await openSocket(port)
    const hello = await socket.next((m) => m.type === 'hello')
    expect(hello).toMatchObject({ capabilities: ['exec', 'pty', 'classify'] })
    await socket.close()
  })

  it('creates an exec session, streams output to the creator, pushes exit and the session list', async () => {
    const { port } = await start()
    const socket = await openHelloedSocket(port)
    const info = result<SessionInfo>(
      await socket.request({
        type: 'create',
        kind: 'exec',
        command: 'echo hello',
        shell: 'model',
        owner: { source: 'model', threadId: 't1' },
      }),
    )
    const exit = await socket.next((m) => m.type === 'exit' && m.session === info.id)
    expect(exit).toMatchObject({ exitCode: 0 })
    const read = result<{ data: string }>(await socket.request({ type: 'read', session: info.id, format: 'plain' }))
    expect(read.data).toBe('hello\n')
    const lists = socket.messages.filter((m) => m.type === 'sessions')
    expect(lists.length).toBeGreaterThan(0)
    await socket.close()
  })

  it('replays output on attach so a second client can catch up', async () => {
    const { port } = await start()
    const first = await openHelloedSocket(port)
    const info = result<SessionInfo>(
      await first.request({
        type: 'create',
        kind: 'exec',
        command: 'printf abc',
        shell: 'model',
        owner: { source: 'model', threadId: 't1' },
      }),
    )
    await first.next((m) => m.type === 'exit' && m.session === info.id)
    const second = await openHelloedSocket(port)
    const replay = result<{ data: string; nextOffset: number }>(
      await second.request({ type: 'attach', session: info.id, sinceOffset: 0 }),
    )
    expect(Buffer.from(replay.data, 'base64').toString()).toBe('abc')
    expect(replay.nextOffset).toBe(3)
    await first.close()
    await second.close()
  })

  it('classifies commands', async () => {
    const { port } = await start()
    const socket = await openHelloedSocket(port)
    expect(result(await socket.request({ type: 'classify', command: 'rm -rf build' }))).toMatchObject({
      sensitive: true,
      reasons: ['recursive delete'],
    })
    await socket.close()
  })

  it('maps a cwd outside the root to cwd_outside_root', async () => {
    const { port } = await start()
    const socket = await openHelloedSocket(port)
    const reply = await socket.request({
      type: 'create',
      kind: 'exec',
      command: 'ls',
      cwd: '..',
      shell: 'model',
      owner: { source: 'model' },
    })
    expect(reply).toMatchObject({ type: 'error', code: 'cwd_outside_root' })
    await socket.close()
  })

  it('closing the server kills running sessions', async () => {
    const srv = await start()
    const socket = await openHelloedSocket(srv.port)
    const info = result<SessionInfo>(
      await socket.request({
        type: 'create',
        kind: 'exec',
        command: 'sleep 60 & echo job:$!; wait',
        shell: 'model',
        owner: { source: 'model' },
      }),
    )
    const output = await socket.next((m) => m.type === 'output' && m.session === info.id)
    const job = Number(/job:(\d+)/.exec(Buffer.from((output as { data: string }).data, 'base64').toString())?.[1])
    await srv.close()
    server = undefined
    expect(() => process.kill(job, 0)).toThrow()
  })
})
