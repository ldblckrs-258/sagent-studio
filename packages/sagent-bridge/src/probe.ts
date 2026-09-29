import { lstat, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside } from './confine.js'
import type { VerifyRootResult } from './protocol.js'

export const PROBE_DIR = '.sagent'
export const PROBE_PREFIX = 'bridge-probe-'
const MAX_PROBE_BYTES = 256

export async function verifyRoot(root: string, nonce: string): Promise<VerifyRootResult> {
  const path = join(root, PROBE_DIR, `${PROBE_PREFIX}${nonce}`)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_PROBE_BYTES) return { matches: false }
    if (!isInside(root, await realpath(path))) return { matches: false }
    const content = await readFile(path, 'utf8')
    return { matches: content === nonce }
  } catch {
    return { matches: false }
  } finally {
    await unlink(path).catch(() => {})
  }
}

export async function cleanupProbes(root: string): Promise<void> {
  const dir = join(root, PROBE_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries.filter((name) => name.startsWith(PROBE_PREFIX)).map((name) => unlink(join(dir, name)).catch(() => {})),
  )
}
