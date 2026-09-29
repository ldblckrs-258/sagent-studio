import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ConfigError, deriveOrigins, isBroadRoot, parseCliArgs, resolveConfig, resolveToken } from './config.js'
import { BRIDGE_VERSION } from './protocol.js'

let work: string

beforeAll(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), 'bridge-config-')))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('parseCliArgs', () => {
  it('requires --root because the bridge must never default to an arbitrary folder', () => {
    expect(() => parseCliArgs([])).toThrow(ConfigError)
  })

  it('does not open a browser unless --open is passed', () => {
    expect(parseCliArgs(['--root', '.']).open).toBe(false)
  })

  it('never accepts a token on argv, where ps would show it', () => {
    expect(() => parseCliArgs(['--root', '.', '--token', 'abc'])).toThrow(ConfigError)
  })

  it('parses repeated origins and flags', () => {
    const options = parseCliArgs(['--root', '.', '--origin', 'https://a.dev', '--origin', 'https://b.dev', '--open'])
    expect(options.origins).toEqual(['https://a.dev', 'https://b.dev'])
    expect(options.open).toBe(true)
    expect(options.port).toBe(7717)
  })
})

describe('deriveOrigins', () => {
  it('adds the loopback twin of a local app url so both spellings of the dev server connect', () => {
    expect([...deriveOrigins('http://localhost:5173/', [])]).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
  })

  it('does not add a twin for a hosted app', () => {
    expect([...deriveOrigins('https://studio.example.com/app/', [])]).toEqual(['https://studio.example.com'])
  })

  it('rejects wildcard origins, which would let any site drive the shell', () => {
    expect(() => deriveOrigins('http://localhost:5173', ['https://*.example.com'])).toThrow(ConfigError)
  })
})

describe('broad root refusal', () => {
  it('treats /, $HOME and ancestors of $HOME as broad', () => {
    expect(isBroadRoot('/', '/Users/me')).toBe(true)
    expect(isBroadRoot('/Users/me', '/Users/me')).toBe(true)
    expect(isBroadRoot('/Users', '/Users/me')).toBe(true)
    expect(isBroadRoot('/Users/me/project', '/Users/me')).toBe(false)
    expect(isBroadRoot('/Users/me2', '/Users/me')).toBe(false)
  })

  it('refuses $HOME as root unless --allow-broad-root is passed', async () => {
    const options = parseCliArgs(['--root', work])
    await expect(resolveConfig(options, {}, work)).rejects.toThrow(/broad root/)
    const allowed = await resolveConfig({ ...options, allowBroadRoot: true }, {}, work)
    expect(allowed.root).toBe(work)
  })

  it('refuses a missing root or a file root', async () => {
    const file = join(work, 'file.txt')
    await writeFile(file, 'x')
    await expect(resolveConfig(parseCliArgs(['--root', join(work, 'nope')]), {}, '/nonexistent-home')).rejects.toThrow(
      /does not exist/,
    )
    await expect(resolveConfig(parseCliArgs(['--root', file]), {}, '/nonexistent-home')).rejects.toThrow(
      /not a directory/,
    )
  })
})

describe('token source', () => {
  it('generates a fresh 32-byte token per start when no env override exists', () => {
    const a = resolveToken({})
    const b = resolveToken({})
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
  })

  it('uses SAGENT_BRIDGE_TOKEN for automation and rejects unsafe characters', () => {
    expect(resolveToken({ SAGENT_BRIDGE_TOKEN: 'abcdefghijklmnop' })).toBe('abcdefghijklmnop')
    expect(() => resolveToken({ SAGENT_BRIDGE_TOKEN: 'short' })).toThrow(ConfigError)
    expect(() => resolveToken({ SAGENT_BRIDGE_TOKEN: 'has,comma,that-breaks-subprotocols' })).toThrow(ConfigError)
  })
})

it('BRIDGE_VERSION matches package.json so the app shows the right npx command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  expect(BRIDGE_VERSION).toBe(pkg.version)
})
