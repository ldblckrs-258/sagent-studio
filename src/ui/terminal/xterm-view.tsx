import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import type { TerminalPort } from '../../terminal/types'
import { readTerminalTheme } from './terminal-theme'
import { attachSession } from './use-terminal'

export default function XtermView({
  port,
  sessionId,
  running,
}: {
  port: TerminalPort
  sessionId: string
  running: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(running)

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: getComputedStyle(host).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12,
      scrollback: 5000,
      screenReaderMode: true,
      cursorBlink: true,
      theme: readTerminalTheme(host),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    term.attachCustomKeyEventHandler((event) => {
      const copy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && event.type === 'keydown'
      if (copy && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
        return false
      }
      return true
    })

    const input = term.onData((data) => {
      if (runningRef.current) void port.input(sessionId, data, 'user').catch(() => undefined)
    })
    const detach = attachSession(port, sessionId, (data) => term.write(data))

    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fit.fit()
        if (runningRef.current) void port.resize(sessionId, term.cols, term.rows).catch(() => undefined)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => {
      term.options.theme = readTerminalTheme(host)
    }
    scheme.addEventListener('change', onScheme)

    return () => {
      scheme.removeEventListener('change', onScheme)
      observer.disconnect()
      cancelAnimationFrame(frame)
      detach()
      input.dispose()
      term.dispose()
    }
  }, [port, sessionId])

  return (
    <div
      ref={hostRef}
      data-slot="xterm-view"
      className="bg-paper-sunk h-full min-h-0 w-full overflow-hidden p-1"
      onClick={() => hostRef.current?.querySelector('textarea')?.focus()}
    />
  )
}
