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
  const background = token('--color-term-bg', '#16130f')
  const ink = token('--color-term-ink', '#f0ece6')
  const muted = token('--color-term-muted', '#aaa39b')
  const faint = token('--color-term-faint', '#8b847c')
  const rule = token('--color-term-rule', '#39342e')
  const red = token('--color-term-red', '#f07a6e')
  const green = token('--color-term-green', '#6fcf97')
  const yellow = token('--color-term-yellow', '#e8c36f')
  const blue = token('--color-term-blue', '#8fa9ea')
  const magenta = token('--color-term-magenta', '#d39ad8')
  const cyan = token('--color-term-cyan', '#62d0dc')
  return {
    background,
    foreground: ink,
    cursor: cyan,
    cursorAccent: background,
    selectionBackground: token('--color-term-selection', '#28525a'),
    selectionForeground: ink,
    scrollbarSliderBackground: `${rule}99`,
    scrollbarSliderHoverBackground: `${faint}99`,
    scrollbarSliderActiveBackground: `${muted}99`,
    black: token('--color-term-black', '#4a453f'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: muted,
    brightBlack: faint,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: ink,
  }
}
