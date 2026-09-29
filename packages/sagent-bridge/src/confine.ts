import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { BridgeError } from './errors.js'

export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

export async function resolveCwd(root: string, cwd: string | undefined): Promise<string> {
  const candidate = resolve(root, cwd ?? '.')
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    if (!isInside(root, candidate)) throw new BridgeError('cwd_outside_root', `cwd is outside the workspace: ${cwd}`)
    throw new BridgeError('bad_request', `cwd does not exist: ${cwd}`)
  }
  if (!isInside(root, real)) throw new BridgeError('cwd_outside_root', `cwd is outside the workspace: ${cwd}`)
  if (!(await stat(real)).isDirectory()) throw new BridgeError('bad_request', `cwd is not a directory: ${cwd}`)
  return real
}

export function displayCwd(root: string, cwd: string): string {
  const rel = relative(root, cwd)
  return rel === '' ? '.' : rel
}

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']

export function sessionEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.SAGENT_BRIDGE = '1'
  return env
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`
  return path
}

export function leavesRoot(root: string, home: string, path: string): boolean {
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) return true
  const expanded = expandHome(path, home)
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
  return !isInside(root, absolute)
}
