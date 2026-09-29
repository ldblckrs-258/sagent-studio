import { spawn as nodeSpawn } from 'node:child_process'

type SpawnFn = (command: string, args: string[], options: { stdio: 'ignore'; detached: boolean }) => {
  on(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export function browserCommand(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'open'
  if (platform === 'linux') return 'xdg-open'
  return null
}

export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
): boolean {
  const command = browserCommand(platform)
  if (!command) return false
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
