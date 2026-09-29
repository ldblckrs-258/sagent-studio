import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolSet } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandApprovalFor } from '../../terminal/approval'
import { TerminalManager } from '../../terminal/manager'
import { nodeSocketFactory, startBridge, TEST_APP_ORIGIN, type BridgeProcess } from '../../terminal/test-utils/bridge-process'
import { nodeDirHandle } from '../../terminal/test-utils/node-dir-handle'
import { COMMAND_TOOLS } from '../approval'
import { ToolRegistry } from '../registry'
import type { ToolResult } from '../result'
import type { ToolRuntimePorts } from '../types'
import { defaultSettings } from '../../vault/settings'
import { createTerminalToolProvider } from './terminal'

let root: string
let bridge: BridgeProcess
let manager: TerminalManager

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'app-terminal-tools-')))
  bridge = await startBridge({ root })
  const settings = { ...defaultSettings(), terminal: { url: bridge.url, token: bridge.token } }
  manager = new TerminalManager({
    getSettings: () => settings,
    saveConfig: async () => {},
    handleFor: async () => nodeDirHandle(root),
    socketFactory: nodeSocketFactory(),
    fetch: (input, init) => fetch(input, { ...init, headers: { Origin: TEST_APP_ORIGIN } }),
    queryLoopbackPermission: async () => null,
    takePendingPair: () => null,
  })
  manager.revive()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge not ready: ${manager.view().reason}`)), 10000)
    const off = manager.onChange(() => {
      if (manager.view().status !== 'ready') return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
})

afterAll(async () => {
  manager.dispose()
  await bridge.stop()
  rmSync(root, { recursive: true, force: true })
})

function tools(threadId = 't1', runId?: string): ToolSet {
  const registry = new ToolRegistry()
  registry.registerProvider(createTerminalToolProvider())
  const ports: ToolRuntimePorts = {
    terminal: { port: manager, threadId, ...(runId !== undefined ? { runId } : {}) },
  }
  return registry.buildToolSet(registry.availableNames(ports), ports)
}

let counter = 0

async function call(
  name: string,
  input: Record<string, unknown>,
  options: { threadId?: string; signal?: AbortSignal; skipApproval?: boolean } = {},
): Promise<ToolResult<Record<string, unknown>>> {
  const threadId = options.threadId ?? 't1'
  const toolCallId = `call-${++counter}`
  if (COMMAND_TOOLS.has(name) && !options.skipApproval) {
    const decision = await commandApprovalFor(
      manager,
      { threadId, mode: 'god', settings: { tools: { [name]: 'allow' } } },
      name,
      input,
      toolCallId,
    )
    expect(decision.type).toBe('approved')
  }
  const execute = tools(threadId)[name]?.execute
  if (!execute) throw new Error(`no tool ${name}`)
  return (await execute(input, {
    toolCallId,
    messages: [],
    context: {},
    ...(options.signal ? { abortSignal: options.signal } : {}),
  } as never)) as ToolResult<Record<string, unknown>>
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('terminal tools against a real bridge', { timeout: 30000 }, () => {
  it('run_command returns the exit code and output', async () => {
    const result = await call('run_command', { command: 'printf a; exit 4' })
    expect(result).toMatchObject({ ok: true, value: { exitCode: 4, output: 'a', timedOut: false } })
  })

  it('run_command reports a timeout', async () => {
    const result = await call('run_command', { command: 'sleep 30', timeoutMs: 1000 })
    expect(result.value).toMatchObject({ timedOut: true })
  })

  it('aborting run_command kills the process it started', async () => {
    const controller = new AbortController()
    const pending = call('run_command', { command: 'sleep 60 & echo job:$!; wait' }, { signal: controller.signal })
    await expect.poll(() => manager.sessions().some((s) => s.running && s.command?.includes('job:'))).toBe(true)
    const session = manager.sessions().find((s) => s.running && s.command?.includes('job:'))!
    await expect.poll(async () => (await manager.read(session.id, { format: 'plain' })).data).toContain('job:')
    const job = Number(/job:(\d+)/.exec((await manager.read(session.id, { format: 'plain' })).data)![1])
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'denied', message: 'aborted' })
    await expect.poll(() => isAlive(job)).toBe(false)
  })

  it('refuses to run a call that never passed approval', async () => {
    const result = await call('run_command', { command: 'echo hi' }, { skipApproval: true })
    expect(result).toMatchObject({ ok: false, code: 'denied' })
  })

  it('refuses a cwd outside the workspace', async () => {
    const result = await call('run_command', { command: 'ls', cwd: '..' })
    expect(result).toMatchObject({ ok: false, code: 'path_rejected' })
  })

  it('starts a long-running session, reads new output by offset, and kills it', async () => {
    const started = await call('terminal_start', {
      command: 'node -e "let i=0;setInterval(()=>console.log(\'tick\'+(i++)),100)"',
      waitMs: 600,
    })
    expect(started.ok).toBe(true)
    const session = started.value!.session as string
    const first = started.value!.nextOffset as number
    await new Promise((resolve) => setTimeout(resolve, 400))
    const read = await call('terminal_read', { session, sinceOffset: first })
    expect(read.value!.output).toMatch(/tick\d+/)
    expect(read.value!.fromOffset).toBe(first)
    expect(read.value!.nextOffset as number).toBeGreaterThan(first)
    expect(await call('terminal_kill', { session })).toMatchObject({ ok: true, value: { killed: true } })
  })

  it('answers a prompt through terminal_write', async () => {
    const started = await call('terminal_start', { command: 'read -p "ok? " x; echo got:$x', waitMs: 800 })
    const session = started.value!.session as string
    const written = await call('terminal_write', { session, input: 'y', waitMs: 1500 })
    expect(written.value!.output).toContain('got:y')
  })

  it('interrupts a running program with ctrl-c', async () => {
    const started = await call('terminal_start', { waitMs: 800 })
    const session = started.value!.session as string
    await call('terminal_write', { session, input: 'sleep 30', waitMs: 300 })
    await call('terminal_write', { session, keys: ['ctrl-c'], submit: false, waitMs: 300 })
    const after = await call('terminal_write', { session, input: 'echo back', waitMs: 800 })
    expect(after.value!.output).toContain('back')
    await call('terminal_kill', { session })
  })

  it('hides sessions of other conversations: they are not_found and not listed', async () => {
    const started = await call('terminal_start', { command: 'sleep 30', waitMs: 100 }, { threadId: 'other' })
    const session = started.value!.session as string
    expect(await call('terminal_read', { session })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await call('terminal_kill', { session })).toMatchObject({ ok: false, code: 'not_found' })
    const listed = await call('terminal_list', {})
    expect((listed.value!.sessions as { session: string }[]).map((s) => s.session)).not.toContain(session)
    await call('terminal_kill', { session }, { threadId: 'other' })
  })

  it('never returns the bridge token in command output', async () => {
    writeFileSync(join(root, 'secret.txt'), `token=${bridge.token}\n`)
    const result = await call('run_command', { command: 'cat secret.txt' })
    expect(result.value!.output).toBe('token=[redacted]\n')
    expect(JSON.stringify(result)).not.toContain(bridge.token)
  })
})
