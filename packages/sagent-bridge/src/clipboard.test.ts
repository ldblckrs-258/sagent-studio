import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { clipboardCommands, copyToClipboard } from './clipboard.js'

type Outcome = number | 'missing'

function fakeSpawn(outcomes: Record<string, Outcome>) {
  const calls: { command: string; written: string }[] = []
  const spawn = (command: string) => {
    const child = new EventEmitter()
    const call = { command, written: '' }
    calls.push(call)
    const stdin = Object.assign(new EventEmitter(), {
      end: (data: string) => {
        call.written = data
        const outcome = outcomes[command] ?? 'missing'
        queueMicrotask(() => {
          if (outcome === 'missing') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          else child.emit('close', outcome)
        })
      },
    })
    return Object.assign(child, { stdin })
  }
  return { spawn, calls }
}

describe('copyToClipboard', () => {
  it('pipes the link into pbcopy on macOS', async () => {
    const { spawn, calls } = fakeSpawn({ pbcopy: 0 })
    expect(await copyToClipboard('http://127.0.0.1:7717/pair?code=abc', 'darwin', spawn)).toBe(true)
    expect(calls).toEqual([{ command: 'pbcopy', written: 'http://127.0.0.1:7717/pair?code=abc' }])
  })

  it('falls through to the next Linux tool when one is missing or fails, since desktops ship different ones', async () => {
    const { spawn, calls } = fakeSpawn({ xclip: 1, xsel: 0 })
    expect(await copyToClipboard('link', 'linux', spawn)).toBe(true)
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip', 'xsel'])
  })

  it('reports failure instead of throwing when no clipboard tool works, so the bridge keeps running', async () => {
    const { spawn } = fakeSpawn({})
    expect(await copyToClipboard('link', 'linux', spawn)).toBe(false)
    expect(await copyToClipboard('link', 'win32', spawn)).toBe(false)
    expect(clipboardCommands('win32')).toEqual([])
  })
})
