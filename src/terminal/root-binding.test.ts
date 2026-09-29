import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BridgeClient } from './client'
import { createRootBinding } from './root-binding'
import { nodeSocketFactory, startBridge, type BridgeProcess } from './test-utils/bridge-process'
import { nodeDirHandle } from './test-utils/node-dir-handle'

let base: string
let root: string
let other: string
let bridge: BridgeProcess
let client: BridgeClient

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'app-binding-')))
  root = join(base, 'project')
  other = join(base, 'other')
  mkdirSync(root)
  mkdirSync(other)
  bridge = await startBridge({ root })
  client = new BridgeClient({
    url: bridge.url,
    token: bridge.token,
    clientVersion: 'test',
    socketFactory: nodeSocketFactory(),
  })
  await client.connect()
})

afterAll(async () => {
  client.close()
  await bridge.stop()
  rmSync(base, { recursive: true, force: true })
})

function binding(handles: Record<string, FileSystemDirectoryHandle | null>, epoch = { value: 1 }) {
  let probes = 0
  const b = createRootBinding({
    handleFor: async (threadId) => handles[threadId] ?? null,
    verify: async (nonce) => {
      probes++
      return (await client.request<{ matches: boolean }>({ type: 'verifyRoot', nonce })).matches
    },
    epoch: () => epoch.value,
    connected: () => true,
  })
  return { b, probes: () => probes }
}

describe('root binding', { timeout: 20000 }, () => {
  it('binds when the thread folder is the bridge root, and leaves no probe file behind', async () => {
    const { b } = binding({ t1: nodeDirHandle(root) })
    expect(await b.ensureBound('t1')).toEqual({ ok: true })
    expect(readdirSync(join(root, '.sagent'))).toEqual([])
  })

  it('refuses when the thread folder is a different directory', async () => {
    const { b } = binding({ t1: nodeDirHandle(other) })
    expect(await b.ensureBound('t1')).toMatchObject({ ok: false, code: 'root_mismatch' })
    expect(readdirSync(join(other, '.sagent'))).toEqual([])
  })

  it('runs one probe for parallel calls and caches the result for the connection epoch', async () => {
    const { b, probes } = binding({ t1: nodeDirHandle(root) })
    const results = await Promise.all([b.ensureBound('t1'), b.ensureBound('t1')])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    await b.ensureBound('t1')
    expect(probes()).toBe(1)
  })

  it('probes again after the folder is re-picked to another directory', async () => {
    const handles: Record<string, FileSystemDirectoryHandle> = { t1: nodeDirHandle(root) }
    const { b, probes } = binding(handles)
    expect(await b.ensureBound('t1')).toEqual({ ok: true })
    handles.t1 = nodeDirHandle(other)
    expect(await b.ensureBound('t1')).toMatchObject({ ok: false, code: 'root_mismatch' })
    expect(probes()).toBe(2)
  })

  it('probes again on a new connection epoch, since a restarted bridge may have a new root', async () => {
    const epoch = { value: 1 }
    const { b, probes } = binding({ t1: nodeDirHandle(root) }, epoch)
    await b.ensureBound('t1')
    epoch.value = 2
    await b.ensureBound('t1')
    expect(probes()).toBe(2)
  })

  it('does not cache a mismatch, so fixing the bridge root works on the next call', async () => {
    const { b, probes } = binding({ t1: nodeDirHandle(other) })
    await b.ensureBound('t1')
    await b.ensureBound('t1')
    expect(probes()).toBe(2)
  })

  it('reports permission_denied without prompting when write access is not granted', async () => {
    const handle = nodeDirHandle(root)
    handle.permission = 'prompt'
    const { b, probes } = binding({ t1: handle })
    expect(await b.ensureBound('t1')).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(probes()).toBe(0)
  })

  it('reports no_workspace when the thread has no folder', async () => {
    const { b } = binding({})
    expect(await b.ensureBound('t1')).toMatchObject({ ok: false, code: 'no_workspace' })
  })
})
