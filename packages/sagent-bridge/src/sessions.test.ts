import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initClassifier } from './classify.js'
import { verifyRoot } from './probe.js'
import type { SessionInfo, SessionOwner } from './protocol.js'
import { loadPty, type PtyModule } from './pty.js'
import { MAX_LIVE_SESSIONS, SessionManager, type CreateRequest } from './sessions.js'

let root: string
let pty: PtyModule | null
const managers: SessionManager[] = []

const owner: SessionOwner = { source: 'model', threadId: 't1' }

function manager(overrides: { pty?: PtyModule | null } = {}) {
  const exits: SessionInfo[] = []
  const m = new SessionManager({
    root,
    home: homedir(),
    env: process.env,
    pty: overrides.pty === undefined ? pty : overrides.pty,
    events: { output: () => {}, exit: (info) => exits.push(info), changed: () => {} },
  })
  managers.push(m)
  return { m, exits }
}

function request(partial: Partial<CreateRequest>): CreateRequest {
  return { type: 'create', id: 'x', kind: 'exec', shell: 'model', owner, ...partial }
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('waitFor timed out')
}

function text(m: SessionManager, id: string): string {
  return m.read(id, 0, undefined, 'plain').data
}

function running(m: SessionManager, id: string): boolean {
  return m.list().find((s) => s.id === id)?.running ?? false
}

async function runToEnd(m: SessionManager, command: string) {
  const info = await m.create(request({ command }))
  await waitFor(() => !running(m, info.id))
  return m.list().find((s) => s.id === info.id) as SessionInfo
}

function internals(m: SessionManager): Map<string, { pid: number; pty?: { process: string } }> {
  return (m as unknown as { sessions: Map<string, { pid: number; pty?: { process: string } }> }).sessions
}

function sidOf(m: SessionManager, id: string): number {
  return internals(m).get(id)!.pid
}

function modelInput(m: SessionManager, id: string, data: string): void {
  m.input(id, data, 'model', m.classifyInput(id, data, undefined, false).inputVersion)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function jobPid(m: SessionManager, id: string): Promise<number> {
  const match = await waitFor(() => /job:(\d+)/.exec(text(m, id)) ?? undefined)
  return Number(match[1])
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-sessions-')))
  pty = await loadPty()
  await initClassifier()
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.shutdown()))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('exec sessions', () => {
  it('reports exit codes and output', async () => {
    const { m } = manager()
    const ok = await runToEnd(m, 'echo hi')
    expect(ok.exitCode).toBe(0)
    expect(text(m, ok.id)).toBe('hi\n')
    expect((await runToEnd(m, 'exit 3')).exitCode).toBe(3)
  })

  it('merges stdout and stderr in arrival order', async () => {
    const { m } = manager()
    const info = await runToEnd(m, 'echo a; echo b 1>&2; echo c')
    expect(text(m, info.id)).toBe('a\nb\nc\n')
  })

  it('ignores stdin so cat and prompts cannot hang', async () => {
    const { m } = manager()
    const info = await runToEnd(m, 'cat')
    expect(info.exitCode).toBe(0)
  })

  it('runs under bash without the user profile', async () => {
    const { m } = manager()
    const info = await runToEnd(m, 'echo "$BASH_VERSION" ; shopt -q login_shell && echo login || echo nologin')
    expect(text(m, info.id)).toMatch(/^\d.*\nnologin\n$/)
  })

  it('does not leak the bridge token into the command environment', async () => {
    const { m } = manager()
    process.env.SAGENT_BRIDGE_TOKEN = 'leaky_token_0123456789'
    try {
      const info = await runToEnd(m, 'env')
      expect(text(m, info.id)).not.toContain('leaky_token_0123456789')
      expect(text(m, info.id)).toContain('SAGENT_BRIDGE=1')
    } finally {
      delete process.env.SAGENT_BRIDGE_TOKEN
    }
  })

  it('times out and reports timedOut', async () => {
    const { m } = manager()
    const info = await m.create(request({ command: 'sleep 30', timeoutMs: 1000 }))
    const sid = sidOf(m, info.id)
    const done = await waitFor(() => {
      const s = m.list().find((x) => x.id === info.id)
      return s && !s.running ? s : undefined
    })
    expect(done.timedOut).toBe(true)
    expect(isAlive(sid)).toBe(false)
  })

  it('kill leaves no background job behind', async () => {
    const { m } = manager()
    const info = await m.create(request({ command: 'sleep 60 & echo job:$!; wait' }))
    const job = await jobPid(m, info.id)
    expect(isAlive(job)).toBe(true)
    expect(await m.kill(info.id)).toMatchObject({ killed: true })
    expect(isAlive(job)).toBe(false)
    expect(isAlive(sidOf(m, info.id))).toBe(false)
  })

  it('kills leftover background processes when the command itself exits', async () => {
    const { m } = manager()
    const info = await m.create(request({ command: 'sleep 60 & echo job:$!' }))
    const job = await jobPid(m, info.id)
    await waitFor(() => !running(m, info.id))
    await waitFor(() => !isAlive(job))
  })

  it('refuses a cwd outside the root', async () => {
    const { m } = manager()
    await expect(m.create(request({ command: 'ls', cwd: '..' }))).rejects.toMatchObject({ code: 'cwd_outside_root' })
  })

  it('enforces the live session limit', async () => {
    const { m } = manager()
    const started: string[] = []
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) started.push((await m.create(request({ command: 'sleep 30' }))).id)
    await expect(m.create(request({ command: 'sleep 30' }))).rejects.toMatchObject({ code: 'session_limit' })
    await m.kill(started[0])
    await expect(m.create(request({ command: 'true' }))).resolves.toBeDefined()
  })

  it('killOwned kills only sessions of the given run', async () => {
    const { m } = manager()
    const mine = await m.create(request({ command: 'sleep 30', owner: { source: 'agent', threadId: 't1', runId: 'r1' } }))
    const other = await m.create(request({ command: 'sleep 30', owner: { source: 'agent', threadId: 't1', runId: 'r2' } }))
    expect(await m.killOwned({ runId: 'r1' })).toEqual([mine.id])
    expect(running(m, mine.id)).toBe(false)
    expect(running(m, other.id)).toBe(true)
  })

  it('reads from an offset so a reconnecting client resumes where it stopped', async () => {
    const { m } = manager()
    const info = await runToEnd(m, 'printf "one\\ntwo\\n"')
    const first = m.read(info.id, 0, 4, 'raw')
    expect(Buffer.from(first.data, 'base64').toString()).toBe('one\n')
    const rest = m.read(info.id, first.nextOffset, undefined, 'plain')
    expect(rest.data).toBe('two\n')
    expect(rest.truncated).toBe(false)
  })
})

describe('pty sessions', () => {
  it('reports pty_unavailable when the native module cannot load', async () => {
    const { m } = manager({ pty: null })
    await expect(m.create(request({ kind: 'pty' }))).rejects.toMatchObject({ code: 'pty_unavailable' })
  })

  it('loads the prebuilt pty on this platform', () => {
    expect(pty).not.toBeNull()
  })

  it('answers a read -p prompt through input', async () => {
    const { m } = manager()
    const info = await m.create(request({ kind: 'pty', command: 'read -p "ok? " x; echo got:$x' }))
    await waitFor(() => text(m, info.id).includes('ok?'))
    modelInput(m, info.id, 'y\r')
    await waitFor(() => text(m, info.id).includes('got:y'))
  })

  it('kill of an interactive shell also kills its background jobs', async () => {
    const { m } = manager()
    const info = await m.create(request({ kind: 'pty' }))
    await waitFor(() => text(m, info.id).includes('$'))
    modelInput(m, info.id, 'sleep 60 & echo job:$!\r')
    const job = await jobPid(m, info.id)
    await m.kill(info.id)
    expect(isAlive(job)).toBe(false)
  })

  it('a model shell that exits on its own takes its background jobs with it', async () => {
    const { m } = manager()
    const info = await m.create(request({ kind: 'pty' }))
    await waitFor(() => text(m, info.id).includes('$'))
    modelInput(m, info.id, 'sleep 60 & echo job:$!\r')
    const job = await jobPid(m, info.id)
    modelInput(m, info.id, 'exit\r')
    await waitFor(() => !running(m, info.id))
    await waitFor(() => !isAlive(job))
  })

  describe('classifyInput', () => {
    it('classifies a split rm -r + f as sensitive at submit', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      expect(m.classifyInput(info.id, 'rm -r', undefined, false).sensitive).toBe(false)
      modelInput(m, info.id, 'rm -r')
      const result = m.classifyInput(info.id, 'f ~', undefined, true)
      expect(result.sensitive).toBe(true)
      expect(result.reasons).toContain('recursive delete')
    })

    it('treats up + enter as sensitive history replay', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      expect(m.classifyInput(info.id, undefined, ['up', 'enter'], false)).toMatchObject({
        sensitive: true,
        reasons: ['history or completion'],
      })
    })

    it('model shells keep no history, so recall keys and !! cannot replay an approved command', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      modelInput(m, info.id, 'echo marker-one\r')
      await waitFor(() => text(m, info.id).includes('marker-one\n'))
      expect(m.classifyInput(info.id, '\x10\x10\x01\x15', undefined, true).sensitive).toBe(true)
      m.input(info.id, '\x10\r', 'user')
      m.input(info.id, '!!\r', 'user')
      await waitFor(() => text(m, info.id).includes('!!'))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(text(m, info.id).match(/^marker-one$/gm)).toHaveLength(1)
    })

    it('refuses a write whose checked state changed before it ran', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      const first = m.classifyInput(info.id, 'rm -rf victim', undefined, false)
      const second = m.classifyInput(info.id, undefined, ['enter'], false)
      expect(first.sensitive || second.sensitive).toBe(false)
      m.input(info.id, 'rm -rf victim', 'model', first.inputVersion)
      expect(() => m.input(info.id, '\r', 'model', second.inputVersion)).toThrow(
        expect.objectContaining({ code: 'stale_input' }),
      )
      expect(() => m.input(info.id, '\r', 'model')).toThrow(expect.objectContaining({ code: 'stale_input' }))
    })

    it('lets a plain safe command through in the model shell', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      expect(m.classifyInput(info.id, 'git status', undefined, true).sensitive).toBe(false)
    })

    it('accepts y for a read -p prompt', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty', command: 'read -p "ok? " x; echo got:$x' }))
      await waitFor(() => text(m, info.id).includes('ok?'))
      expect(m.classifyInput(info.id, 'y', undefined, true).sensitive).toBe(false)
    })

    it('treats code typed into a REPL as sensitive', async () => {
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty', command: 'node -i' }))
      await waitFor(() => text(m, info.id).includes('>'))
      const result = m.classifyInput(info.id, 'print(1)', undefined, true)
      expect(result.sensitive).toBe(true)
      expect(result.reasons[0]).toMatch(/^input to /)
    })

    it('treats a shell escape inside an editor as sensitive', async () => {
      let hasVim = true
      try {
        execFileSync('which', ['vim'])
      } catch {
        hasVim = false
      }
      if (!hasVim) return
      const { m } = manager()
      const info = await m.create(request({ kind: 'pty' }))
      await waitFor(() => text(m, info.id).includes('$'))
      modelInput(m, info.id, 'vim -u NONE\r')
      await waitFor(() => internals(m).get(info.id)?.pty?.process.includes('vim'))
      const result = m.classifyInput(info.id, ':!rm -rf ~', undefined, true)
      expect(result.sensitive).toBe(true)
      expect(result.reasons[0]).toMatch(/input to vim/)
    })
  })
})

describe('root probe', () => {
  it('matches the nonce and deletes the probe file', async () => {
    await mkdir(join(root, '.sagent'), { recursive: true })
    await writeFile(join(root, '.sagent', 'bridge-probe-abcdefgh123'), 'abcdefgh123')
    expect(await verifyRoot(root, 'abcdefgh123')).toEqual({ matches: true })
    expect(await readdir(join(root, '.sagent'))).toEqual([])
  })

  it('does not match a different root or wrong content', async () => {
    await mkdir(join(root, '.sagent'), { recursive: true })
    await writeFile(join(root, '.sagent', 'bridge-probe-zzzzzzzz'), 'other')
    expect(await verifyRoot(root, 'zzzzzzzz')).toEqual({ matches: false })
    expect(await verifyRoot(root, 'missing1234')).toEqual({ matches: false })
  })
})
