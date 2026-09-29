import { spawn as nodeSpawn } from 'node:child_process'

type ClipboardChild = {
  stdin: { end(data: string): void; on(event: 'error', listener: (error: Error) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
}

type SpawnFn = (command: string, args: string[], options: { stdio: ['pipe', 'ignore', 'ignore'] }) => ClipboardChild

export function clipboardCommands(platform: NodeJS.Platform): [string, string[]][] {
  if (platform === 'darwin') return [['pbcopy', []]]
  if (platform === 'linux') {
    return [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ]
  }
  return []
}

function tryCopy(command: string, args: string[], text: string, spawn: SpawnFn): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ClipboardChild
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    child.stdin?.on('error', () => resolve(false))
    child.stdin?.end(text)
  })
}

export async function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
): Promise<boolean> {
  for (const [command, args] of clipboardCommands(platform)) {
    if (await tryCopy(command, args, text, spawn)) return true
  }
  return false
}
