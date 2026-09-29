import type { ITheme } from '@xterm/xterm'

function resolveColor(context: CanvasRenderingContext2D, value: string, fallback: string): string {
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = fallback
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function readTerminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const token = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    if (!context || value === '') return fallback
    return resolveColor(context, value, fallback)
  }
  const ink = token('--color-ink', '#2b2622')
  const paper = token('--color-paper-sunk', '#f5f1ea')
  const accent = token('--color-accent', '#0f6f7a')
  return {
    background: paper,
    foreground: ink,
    cursor: accent,
    cursorAccent: paper,
    selectionBackground: token('--color-accent-soft', '#dff1f3'),
    selectionForeground: ink,
    black: ink,
    red: token('--color-danger', '#b3261e'),
    green: token('--color-positive', '#1f7a4d'),
    yellow: token('--color-caution', '#8a5a14'),
    blue: token('--color-file-code', '#3656b3'),
    magenta: token('--color-file-media', '#8e3b8e'),
    cyan: accent,
    white: token('--color-muted', '#7a7068'),
    brightBlack: token('--color-faint', '#8b8178'),
  }
}
