#!/usr/bin/env node
import { homedir } from 'node:os'
import { copyToClipboard } from './clipboard.js'
import { ConfigError, USAGE, parseCliArgs, resolveConfig } from './config.js'
import { openBrowser } from './open-browser.js'
import { PAIR_CODE_TTL_MS } from './pair.js'
import { startServer, type BridgeServer, type LogLevel } from './server.js'
import { prepareBridge } from './service.js'
import { BRIDGE_VERSION } from './protocol.js'
import { box, clock, painter, supportsColor, tildify, type Color } from './ui.js'

const out = process.stdout
const err = process.stderr
const paintOut = painter(supportsColor(out))
const paintErr = painter(supportsColor(err))

const LEVELS: Record<LogLevel, { mark: string; color: Color }> = {
  info: { mark: '•', color: 'cyan' },
  ok: { mark: '✓', color: 'green' },
  warn: { mark: '!', color: 'yellow' },
  error: { mark: '✗', color: 'red' },
}

function fail(message: string, hint?: string): void {
  err.write(`${paintErr('red', paintErr('bold', 'error'))} ${message}\n`)
  if (hint) err.write(`${paintErr('dim', hint)}\n`)
}

function logLine(line: string, level: LogLevel = 'info'): void {
  const { mark, color } = LEVELS[level]
  err.write(`  ${paintErr('gray', clock())} ${paintErr(color, mark)} ${line}\n`)
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    process.stderr.write('sagent-bridge supports macOS and Linux\n')
    process.exit(1)
  }

  let config
  try {
    config = await resolveConfig(parseCliArgs(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(error.message, USAGE)
      process.exit(2)
    }
    throw error
  }

  const runtime = await prepareBridge(config)
  process.on('exit', () => runtime.killAllSync())

  let server: BridgeServer
  try {
    server = await startServer(config, runtime.createHandler, {
      log: logLine,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail(`port ${config.port} is already in use.`, 'Stop the other process or pass --port <n>.')
      process.exit(1)
    }
    throw error
  }

  const label = (text: string): string => paintOut('dim', text.padEnd(8))
  const [firstOrigin, ...moreOrigins] = [...config.allowedOrigins]
  out.write('\n')
  out.write(
    box(
      [
        `${paintOut('magenta', '◆')} ${paintOut('bold', 'sagent-bridge')} ${paintOut('dim', `v${BRIDGE_VERSION}`)}`,
        '',
        `${label('root')} ${tildify(config.root, homedir())}`,
        `${label('listen')} ${paintOut('cyan', `ws://127.0.0.1:${server.port}`)}`,
        `${label('origins')} ${firstOrigin}`,
        ...moreOrigins.map((origin) => `${' '.repeat(8)} ${origin}`),
      ],
      paintOut,
      out.isTTY ? out.columns : Infinity,
    ),
  )

  const ttlMinutes = Math.round(PAIR_CODE_TTL_MS / 60000)
  const pair = (): void => {
    const url = server.mintPairUrl()
    out.write(`\n  ${paintOut('green', '➜')} ${paintOut('bold', 'Pair')}  ${paintOut('cyan', url)}\n`)
    out.write(`          ${paintOut('dim', `One-time link, expires in ${ttlMinutes} minutes.`)}\n`)
    if (config.open && !openBrowser(url)) {
      out.write(`          ${paintOut('yellow', 'Could not open a browser. Open the link above yourself.')}\n`)
    }
    out.write('\n')
    if (out.isTTY) {
      void copyToClipboard(url).then((copied) => {
        if (copied) logLine('pairing link copied to clipboard', 'ok')
      })
    }
  }
  pair()

  if (process.stdin.isTTY) {
    out.write(
      `  ${paintOut('bold', 'Enter')} ${paintOut('dim', 'new pairing link')}  ${paintOut('gray', '·')}  ${paintOut('bold', 'Ctrl+C')} ${paintOut('dim', 'stop the bridge and its sessions')}\n\n`,
    )
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (chunk.includes('\n') || chunk.includes('\r')) pair()
    })
  }

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    logLine('stopping, killing sessions', 'warn')
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
}

main().catch((error: unknown) => {
  fail((error as Error).message)
  process.exit(1)
})
