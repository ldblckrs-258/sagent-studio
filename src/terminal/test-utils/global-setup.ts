import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const result = spawnSync('pnpm', ['--filter', 'sagent-bridge', 'build'], { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Building sagent-bridge for the terminal tests failed:\n${result.stdout}\n${result.stderr}`)
  }
}
