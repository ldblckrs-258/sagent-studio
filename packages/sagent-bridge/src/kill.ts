import { execFile, execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  sess: number
  tty: string
}

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,sess=,tty=']

export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const [pid, ppid, pgid, sess] = parts.slice(0, 4).map(Number)
    if (![pid, ppid, pgid, sess].every(Number.isInteger)) continue
    rows.push({ pid, ppid, pgid, sess, tty: parts[4] ?? '?' })
  }
  return rows
}

function snapshot(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? [] : parsePs(stdout))
    })
  })
}

function snapshotSync(): ProcessRow[] {
  try {
    return parsePs(execFileSync('ps', PS_ARGS, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  } catch {
    return []
  }
}

export async function ttyOf(pid: number): Promise<string | undefined> {
  const row = (await snapshot()).find((r) => r.pid === pid)
  return row && hasTty(row.tty) ? row.tty : undefined
}

function hasTty(tty: string | undefined): tty is string {
  return tty !== undefined && tty !== '' && !tty.startsWith('?')
}

export interface KillTarget {
  sid: number
  tty?: string
}

export function collectMembers(rows: readonly ProcessRow[], target: KillTarget, known: ReadonlySet<number>): Set<number> {
  const self = process.pid
  const selfPgid = rows.find((row) => row.pid === self)?.pgid
  const members = new Set<number>([target.sid, ...known])
  const pgids = new Set<number>([target.sid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (row.pid === self || row.pid <= 1) continue
      if (members.has(row.pid)) {
        if (row.pgid > 1 && row.pgid !== selfPgid && !pgids.has(row.pgid)) {
          pgids.add(row.pgid)
          changed = true
        }
        continue
      }
      const related =
        (row.sess > 1 && row.sess === target.sid) ||
        members.has(row.ppid) ||
        (row.pgid !== selfPgid && pgids.has(row.pgid)) ||
        (hasTty(target.tty) && row.tty === target.tty)
      if (related) {
        members.add(row.pid)
        changed = true
      }
    }
  }
  members.delete(self)
  return members
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalAll(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      continue
    }
  }
}

async function waitGone(pids: readonly number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !pids.some(alive)
}

function validSid(sid: number): boolean {
  return Number.isInteger(sid) && sid > 1 && sid !== process.pid
}

async function liveMembers(target: KillTarget, known: Set<number>): Promise<number[]> {
  const rows = await snapshot()
  const present = new Set(rows.map((row) => row.pid))
  for (const pid of collectMembers(rows, target, known)) if (present.has(pid)) known.add(pid)
  return [...known].filter((pid) => present.has(pid) && alive(pid))
}

export async function sessionMembers(target: KillTarget): Promise<number[]> {
  if (!validSid(target.sid)) return []
  return liveMembers(target, new Set())
}

const KILL_STEPS: [NodeJS.Signals, number][] = [
  ['SIGHUP', 500],
  ['SIGTERM', 2500],
  ['SIGKILL', 1000],
]

export async function killSessionTree(target: KillTarget): Promise<boolean> {
  if (!validSid(target.sid)) return false
  const known = new Set<number>()
  const withoutTty: KillTarget = { sid: target.sid }
  let first = true
  for (const [signal, waitMs] of KILL_STEPS) {
    const targets = await liveMembers(first ? target : withoutTty, known)
    first = false
    if (targets.length === 0) return true
    signalAll(targets, signal)
    await waitGone(targets, waitMs)
  }
  return (await liveMembers(withoutTty, known)).length === 0
}

export function killSessionTreeSync(target: KillTarget): void {
  if (!validSid(target.sid)) return
  const rows = snapshotSync()
  const present = new Set(rows.map((row) => row.pid))
  signalAll(
    [...collectMembers(rows, target, new Set())].filter((pid) => present.has(pid)),
    'SIGKILL',
  )
}
