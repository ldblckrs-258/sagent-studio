import { describe, expect, it } from 'vitest'
import { collectMembers, parsePs, type ProcessRow } from './kill.js'

const self = process.pid

function row(pid: number, ppid: number, pgid: number, sess = 0, tty = '??'): ProcessRow {
  return { pid, ppid, pgid, sess, tty }
}

describe('collectMembers', () => {
  const bridge = row(self, 50, 50, 0, 'ttys001')

  it('finds descendants, including background jobs in their own process group', () => {
    const rows = [bridge, row(100, self, 100, 0, 'ttys009'), row(101, 100, 101, 0, 'ttys009'), row(102, 101, 101)]
    expect([...collectMembers(rows, { sid: 100 }, new Set())].sort()).toEqual([100, 101, 102])
  })

  it('finds re-parented members through their process group after the leader died', () => {
    const rows = [bridge, row(201, 1, 200)]
    expect([...collectMembers(rows, { sid: 200 }, new Set())]).toContain(201)
  })

  it('finds members by session id where ps reports one (Linux)', () => {
    const rows = [bridge, row(301, 1, 301, 300)]
    expect([...collectMembers(rows, { sid: 300 }, new Set())]).toContain(301)
  })

  it('finds members by the pty tty', () => {
    const rows = [bridge, row(401, 1, 401, 0, 'ttys042')]
    expect([...collectMembers(rows, { sid: 400, tty: 'ttys042' }, new Set())]).toContain(401)
  })

  it('never includes the bridge itself, pid 1, or processes in the bridge process group', () => {
    const rows = [bridge, row(1, 0, 1), row(60, 1, 50), row(500, self, 500)]
    const members = collectMembers(rows, { sid: 500 }, new Set())
    expect(members.has(self)).toBe(false)
    expect(members.has(1)).toBe(false)
    expect(members.has(60)).toBe(false)
  })

  it('ignores a revoked tty so unrelated detached processes are not matched', () => {
    const rows = [bridge, row(700, 1, 700, 0, '??')]
    expect(collectMembers(rows, { sid: 600, tty: '??' }, new Set()).has(700)).toBe(false)
  })
})

it('parsePs reads BSD and procps output', () => {
  expect(parsePs('  1     0     1      0 ??\n 42     1    42     42 pts/3\n')).toEqual([
    { pid: 1, ppid: 0, pgid: 1, sess: 0, tty: '??' },
    { pid: 42, ppid: 1, pgid: 42, sess: 42, tty: 'pts/3' },
  ])
})
