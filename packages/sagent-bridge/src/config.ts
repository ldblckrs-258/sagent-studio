import { createHash, randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULT_PORT } from './protocol.js'

export const DEFAULT_APP_URL = 'http://localhost:5173'

export const USAGE = `Usage: sagent-bridge --root <dir> [--port ${DEFAULT_PORT}] [--app-url ${DEFAULT_APP_URL}] [--origin <url>]... [--open] [--allow-broad-root]`

export class ConfigError extends Error {}

export interface BridgeOptions {
  root: string
  port: number
  appUrl: string
  origins: string[]
  open: boolean
  allowBroadRoot: boolean
}

export interface BridgeConfig {
  root: string
  rootName: string
  rootFingerprint: string
  port: number
  appUrl: string
  allowedOrigins: ReadonlySet<string>
  token: string
  open: boolean
}

export function parseCliArgs(argv: string[]): BridgeOptions {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        port: { type: 'string' },
        'app-url': { type: 'string' },
        origin: { type: 'string', multiple: true },
        open: { type: 'boolean' },
        'allow-broad-root': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch (error) {
    throw new ConfigError((error as Error).message)
  }
  if (!values.root) throw new ConfigError('--root is required')
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid --port: ${values.port}`)
  return {
    root: values.root,
    port,
    appUrl: values['app-url'] ?? DEFAULT_APP_URL,
    origins: values.origin ?? [],
    open: values.open ?? false,
    allowBroadRoot: values['allow-broad-root'] ?? false,
  }
}

function toOrigin(value: string, flag: string): string {
  if (value.includes('*')) throw new ConfigError(`${flag} must not contain wildcards: ${value}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${flag} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${flag} must be http or https: ${value}`)
  return url.origin
}

export function deriveOrigins(appUrl: string, extra: readonly string[]): Set<string> {
  const origins = new Set<string>()
  const app = new URL(toOrigin(appUrl, '--app-url'))
  origins.add(app.origin)
  if (app.hostname === 'localhost' || app.hostname === '127.0.0.1') {
    const twin = new URL(app.origin)
    twin.hostname = app.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    origins.add(twin.origin)
  }
  for (const origin of extra) origins.add(toOrigin(origin, '--origin'))
  return origins
}

export function isBroadRoot(root: string, home: string): boolean {
  if (root === '/' || dirname(root) === root) return true
  return root === home || home.startsWith(root.endsWith('/') ? root : `${root}/`)
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/

export function resolveToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SAGENT_BRIDGE_TOKEN
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!TOKEN_RE.test(fromEnv)) throw new ConfigError('SAGENT_BRIDGE_TOKEN must be 16-256 characters of [A-Za-z0-9_-]')
    return fromEnv
  }
  return randomBytes(32).toString('base64url')
}

export async function resolveConfig(
  options: BridgeOptions,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<BridgeConfig> {
  let root: string
  try {
    root = await realpath(options.root)
  } catch {
    throw new ConfigError(`--root does not exist: ${options.root}`)
  }
  if (!(await stat(root)).isDirectory()) throw new ConfigError(`--root is not a directory: ${options.root}`)
  let realHome: string
  try {
    realHome = await realpath(home)
  } catch {
    realHome = home
  }
  if (!options.allowBroadRoot && isBroadRoot(root, realHome)) {
    throw new ConfigError(
      `Refusing broad root ${root}: pick a project folder, or pass --allow-broad-root to share it anyway`,
    )
  }
  return {
    root,
    rootName: basename(root) || root,
    rootFingerprint: createHash('sha256').update(root).digest('hex'),
    port: options.port,
    appUrl: new URL(options.appUrl).href,
    allowedOrigins: deriveOrigins(options.appUrl, options.origins),
    token: resolveToken(env),
    open: options.open,
  }
}
