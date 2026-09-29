import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isInside, leavesRoot, resolveCwd, sessionEnv } from './confine.js'

let base: string
let root: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'bridge-confine-')))
  root = join(base, 'work')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(base, 'work-evil'), { recursive: true })
  await mkdir(join(base, 'outside'), { recursive: true })
  await symlink(join(base, 'outside'), join(root, 'escape'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('resolveCwd', () => {
  it('resolves relative directories inside the root', async () => {
    expect(await resolveCwd(root, 'src')).toBe(join(root, 'src'))
    expect(await resolveCwd(root, undefined)).toBe(root)
  })

  it('refuses a .. escape', async () => {
    await expect(resolveCwd(root, '../outside')).rejects.toMatchObject({ code: 'cwd_outside_root' })
  })

  it('refuses a symlink that points outside the root', async () => {
    await expect(resolveCwd(root, 'escape')).rejects.toMatchObject({ code: 'cwd_outside_root' })
  })

  it('does not treat a sibling with the same prefix as inside', async () => {
    await expect(resolveCwd(root, '../work-evil')).rejects.toMatchObject({ code: 'cwd_outside_root' })
    expect(isInside('/work', '/work-evil')).toBe(false)
  })

  it('reports a missing directory inside the root as bad_request', async () => {
    await expect(resolveCwd(root, 'nope')).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('sessionEnv', () => {
  it('drops the bridge token and unrelated variables, keeping PATH from the bridge process', () => {
    const env = sessionEnv({
      PATH: '/usr/bin:/nvm/bin',
      HOME: '/home/me',
      LC_ALL: 'en_US.UTF-8',
      SAGENT_BRIDGE_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'x',
      NODE_OPTIONS: '--require evil',
    })
    expect(env).toEqual({
      PATH: '/usr/bin:/nvm/bin',
      HOME: '/home/me',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SAGENT_BRIDGE: '1',
    })
  })
})

describe('leavesRoot', () => {
  it('flags home-relative and absolute paths outside, including ~user', () => {
    expect(leavesRoot('/w', '/home/me', '~/.ssh/id_rsa')).toBe(true)
    expect(leavesRoot('/w', '/home/me', '~root/x')).toBe(true)
    expect(leavesRoot('/w', '/home/me', '/etc/passwd')).toBe(true)
    expect(leavesRoot('/w', '/home/me', '/w/src')).toBe(false)
    expect(leavesRoot('/home/me/w', '/home/me', '~/w/src')).toBe(false)
  })
})
