import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SessionInfo } from 'sagent-bridge/protocol'
import { defaultSettings, type Settings } from '../vault/settings'
import { bridgeStartCommand, TerminalManager } from './manager'
import { nodeSocketFactory, startBridge, TEST_APP_ORIGIN, type BridgeProcess } from './test-utils/bridge-process'
import { nodeDirHandle } from './test-utils/node-dir-handle'
import type { BridgeConfig, BridgeStatus } from './types'

let root: string
const bridges: BridgeProcess[] = []
const managers: TerminalManager[] = []

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'app-manager-')))
})

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function bridge(options: { token?: string; port?: number } = {}): Promise<BridgeProcess> {
  const started = await startBridge({ root, ...options })
  bridges.push(started)
  return started
}

function originFetch(origin: string): typeof fetch {
  return (input, init) => fetch(input, { ...init, headers: { Origin: origin } })
}

function setup(options: { stored?: BridgeConfig; pending?: BridgeConfig; origin?: string } = {}) {
  const origin = options.origin ?? TEST_APP_ORIGIN
  let settings: Settings = { ...defaultSettings(), ...(options.stored ? { terminal: options.stored } : {}) }
  const saved: (BridgeConfig | null)[] = []
  let pending = options.pending ?? null
  const manager = new TerminalManager({
    getSettings: () => settings,
    saveConfig: async (config) => {
      saved.push(config)
      const next = { ...settings }
      if (config) next.terminal = config
      else delete next.terminal
      settings = next
    },
    handleFor: async () => nodeDirHandle(root),
    socketFactory: nodeSocketFactory(origin),
    fetch: originFetch(origin),
    queryLoopbackPermission: async () => null,
    takePendingPair: () => {
      const value = pending
      pending = null
      return value
    },
    appOrigin: () => origin,
    backoffMs: [50],
    maxAttempts: 40,
  })
  managers.push(manager)
  return { manager, saved, settings: () => settings }
}

function waitForStatus(manager: TerminalManager, status: BridgeStatus, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (manager.view().status === status) return resolve()
    const timer = setTimeout(() => {
      off()
      reject(new Error(`status stayed ${manager.view().status}: ${manager.view().reason ?? ''}`))
    }, timeoutMs)
    const off = manager.onChange(() => {
      if (manager.view().status !== status) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

describe('bridgeStartCommand', () => {
  it('shows the plain command on the hosted app, which the published bridge trusts by default', () => {
    expect(bridgeStartCommand('https://sagent-studio.vercel.app')).toMatch(/^npx sagent-bridge@\S+ --root <your project folder>$/)
  })

  it('adds --app-url for any other origin, so a copied command works in dev and self-hosted setups', () => {
    expect(bridgeStartCommand('http://localhost:5173')).toMatch(/ --app-url http:\/\/localhost:5173$/)
  })
})

describe('TerminalManager', { timeout: 30000 }, () => {
  it('stays unpaired with no stored pairing and no link', () => {
    const { manager } = setup()
    manager.revive()
    expect(manager.view()).toMatchObject({ status: 'unpaired', paired: false })
  })

  it('pairs from the deeplink after unlock and saves the pairing only after hello', async () => {
    const b = await bridge()
    const { manager, saved } = setup({ pending: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    expect(saved).toEqual([{ url: b.url, token: b.token }])
    expect(manager.view()).toMatchObject({ rootName: root.split('/').pop(), paired: true })
  })

  it('a link with a bad token never overwrites a working pairing', async () => {
    const b = await bridge()
    const good = { url: b.url, token: b.token }
    const { manager, saved, settings } = setup({ stored: good, pending: { url: b.url, token: 'forged_token_0123456789ab' } })
    manager.revive()
    await waitForStatus(manager, 'needs-auth')
    expect(saved).toEqual([])
    expect(settings().terminal).toEqual(good)
  })

  it('connects with the stored pairing and lists sessions', async () => {
    const b = await bridge()
    const { manager } = setup({ stored: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    const created = await manager.create({
      kind: 'exec',
      command: 'echo hi',
      shell: 'model',
      owner: { source: 'model', threadId: 't1' },
    })
    await expect.poll(() => manager.sessions().find((s) => s.id === created.id)?.running).toBe(false)
  })

  it('reports that the bridge is not running with the exact start command', async () => {
    const { manager } = setup({ stored: { url: 'ws://127.0.0.1:9', token: 'tok_0123456789abcdef' } })
    manager.revive()
    await waitForStatus(manager, 'error')
    expect(manager.view().reason).toMatch(/^Bridge not running: npx sagent-bridge@\d+\.\d+\.\d+ --root/)
  })

  it('tells the user to pass --app-url when the bridge does not allow this origin', async () => {
    const b = await bridge()
    const { manager } = setup({ stored: { url: b.url, token: b.token }, origin: 'https://hosted.example' })
    manager.revive()
    await waitForStatus(manager, 'error')
    expect(manager.view().reason).toBe('Start the bridge with --app-url https://hosted.example')
  })

  it('shows needs-auth after a bridge restart with a new token, and ready after re-pairing', async () => {
    const first = await bridge()
    const { manager } = setup({ stored: { url: first.url, token: first.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    const epoch = manager.epoch()
    await first.stop()
    const second = await bridge({ port: first.port })
    await waitForStatus(manager, 'needs-auth')
    expect(await manager.pair({ url: second.url, token: second.token })).toBe(true)
    expect(manager.view().status).toBe('ready')
    expect(manager.epoch()).toBeGreaterThan(epoch)
  })

  it('reconnects on its own when the bridge restarts with the same token', async () => {
    const first = await bridge({ token: 'same_token_0123456789abcdef' })
    const { manager } = setup({ stored: { url: first.url, token: first.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    const epoch = manager.epoch()
    await first.stop()
    await waitForStatus(manager, 'connecting')
    await bridge({ token: first.token, port: first.port })
    await waitForStatus(manager, 'ready')
    expect(manager.epoch()).toBe(epoch + 1)
  })

  it('replays output to a late subscriber and flags dropped history by offset', async () => {
    const b = await bridge()
    const { manager } = setup({ stored: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    const session: SessionInfo = await manager.create({
      kind: 'exec',
      command: 'printf "one two"',
      shell: 'model',
      owner: { source: 'model', threadId: 't1' },
    })
    await expect.poll(() => manager.sessions().find((s) => s.id === session.id)?.running).toBe(false)
    const chunks: string[] = []
    const off = manager.subscribe(session.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)), 4)
    await expect.poll(() => chunks.join('')).toBe('two')
    off()
  })

  it('binds the root through the manager and refuses after dispose', async () => {
    const b = await bridge()
    const { manager } = setup({ stored: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    expect(await manager.ensureBound('t1')).toEqual({ ok: true })
    manager.dispose()
    expect(await manager.ensureBound('t1')).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('redacts the bridge token from any text', async () => {
    const b = await bridge()
    const { manager } = setup({ stored: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    expect(manager.redact(`token=${b.token}`)).toBe('token=[redacted]')
  })

  it('forget clears the stored pairing', async () => {
    const b = await bridge()
    const { manager, settings } = setup({ stored: { url: b.url, token: b.token } })
    manager.revive()
    await waitForStatus(manager, 'ready')
    await manager.forget()
    expect(settings().terminal).toBeUndefined()
    expect(manager.view()).toMatchObject({ status: 'unpaired', paired: false })
  })
})
