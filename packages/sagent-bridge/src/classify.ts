import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser, type Node } from 'web-tree-sitter'
import { leavesRoot } from './confine.js'
import type { Classification } from './protocol.js'

export interface ClassifyContext {
  root: string
  home: string
}

let parser: Parser | null = null
let loading: Promise<boolean> | null = null

function grammarPath(): string {
  const bundled = fileURLToPath(new URL('./tree-sitter-bash.wasm', import.meta.url))
  if (existsSync(bundled)) return bundled
  return createRequire(import.meta.url).resolve('tree-sitter-bash/tree-sitter-bash.wasm')
}

export function initClassifier(): Promise<boolean> {
  loading ??= (async () => {
    try {
      await Parser.init()
      const language = await Language.load(grammarPath())
      const instance = new Parser()
      instance.setLanguage(language)
      parser = instance
      return true
    } catch {
      parser = null
      return false
    }
  })()
  return loading
}

export function classifierReady(): boolean {
  return parser !== null
}

const REASON = {
  unparseable: 'unparseable command',
  substitution: 'command substitution',
  processSubstitution: 'process substitution',
  heredoc: 'heredoc',
  controlFlow: 'control flow or subshell',
  redirection: 'redirection',
  dynamicName: 'expansion in command name',
  globName: 'glob in command name',
  dynamicArg: 'dynamic argument',
  eval: 'eval or source',
  deferred: 'deferred code',
  shellOption: 'shell option change',
  startsShell: 'starts a shell',
  wrapper: 'wrapper command',
  detaches: 'detaches from session',
  privilege: 'privilege escalation',
  recursiveDelete: 'recursive delete',
  forcedDelete: 'forced delete',
  disk: 'disk tool',
  recursivePermissions: 'recursive permission change',
  killsProcesses: 'kills processes',
  systemControl: 'system control',
  forcePush: 'force push',
  remoteDelete: 'deletes remote ref',
  hardReset: 'hard reset',
  gitClean: 'git clean',
  gitConfig: 'git config change',
  historyRewrite: 'history rewrite',
  publish: 'publishes package',
  registryLogin: 'registry credentials',
  remote: 'remote connection',
  rawNetwork: 'raw network connection',
  upload: 'uploads data',
  pipeInterpreter: 'pipe into interpreter',
  inlineCode: 'inline code',
  findExec: 'find with -delete or -exec',
  outsideRoot: 'path outside workspace',
  envOverride: 'environment override',
  globFlag: 'glob in flag',
  scheduledJob: 'scheduled job',
} as const

const CONTROL_FLOW = new Set([
  'subshell',
  'compound_statement',
  'function_definition',
  'if_statement',
  'for_statement',
  'c_style_for_statement',
  'while_statement',
  'case_statement',
])

const SENSITIVE_VARS =
  /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+|BASH_ENV|ENV|IFS|PROMPT_COMMAND|PS[0-4]|SHELLOPTS|BASHOPTS|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG\w*|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT|RUBYOPT)$/

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'csh',
  'tcsh',
  'fish',
  'pwsh',
  'nu',
  'elvish',
  'xonsh',
])
const PYTHON = /^python(\d+(\.\d+)?)?$/
const INTERPRETERS = new Set(['node', 'perl', 'ruby', 'php', 'osascript', 'deno', 'bun', 'lua', 'Rscript', 'tclsh', 'julia'])
const SAFE_PATHS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'])
const INLINE_FLAGS: Record<string, RegExp> = {
  node: /[ep]/,
  perl: /[eE]/,
  ruby: /e/,
  php: /r/,
  osascript: /e/,
  lua: /e/,
  tclsh: /e/,
  julia: /e/,
}

function isInterpreter(name: string): boolean {
  return SHELLS.has(name) || PYTHON.test(name) || INTERPRETERS.has(name)
}

function unescapeWord(text: string): string {
  return text.replace(/\\(.)/gs, '$1').replace(/\\$/, '')
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\\n/g, '').replace(/\\([\\"$`])/g, '$1')
}

function staticText(node: Node): string | null {
  switch (node.type) {
    case 'word':
      return unescapeWord(node.text)
    case 'number':
      return node.text
    case 'raw_string':
      return node.text.slice(1, -1)
    case 'string': {
      let out = ''
      for (const child of node.namedChildren) {
        if (!child) continue
        if (child.type !== 'string_content') return null
        out += unescapeDoubleQuoted(child.text)
      }
      return out
    }
    case 'concatenation': {
      let out = ''
      for (const child of node.namedChildren) {
        if (!child) return null
        const part = staticText(child)
        if (part === null) return null
        out += part
      }
      return out
    }
    case 'command_name': {
      const inner = node.namedChildren[0]
      return inner ? staticText(inner) : null
    }
    default:
      return null
  }
}

function unquotedText(node: Node): string {
  if (node.type === 'command_name') {
    const inner = node.namedChildren[0]
    return inner ? unquotedText(inner) : ''
  }
  if (node.type === 'word') return node.text
  if (node.type === 'concatenation') {
    return node.namedChildren.map((child) => (child && child.type === 'word' ? child.text : ' ')).join('')
  }
  return ''
}

function hasBraceExpansion(node: Node): boolean {
  return /\{[^{} ]*(,|\.\.)[^{} ]*\}/.test(unquotedText(node))
}

function hasGlob(node: Node): boolean {
  return /[*?[]/.test(unquotedText(node))
}

const ALLOWED_REDIRECT = [/^(?:\d|&)?>{1,2}&?\/dev\/null$/, /^\d?[<>]&\d-?$/]

function isAllowedRedirect(node: Node): boolean {
  const text = node.text.replace(/\s+/g, '')
  return ALLOWED_REDIRECT.some((re) => re.test(text))
}

function isShortCluster(arg: string): boolean {
  return /^-[A-Za-z]/.test(arg) && !arg.startsWith('--')
}

function shortFlags(argv: readonly string[]): string {
  return argv
    .filter(isShortCluster)
    .map((a) => a.slice(1))
    .join('')
}

function leadingOptions(argv: readonly string[]): string[] {
  const out: string[] = []
  for (const arg of argv) {
    if (arg === '--' || !arg.startsWith('-') || arg === '-') break
    out.push(arg)
  }
  return out
}

function positionals(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith('-'))
}

function longPrefix(arg: string, full: string, min = 4): boolean {
  const name = arg.split('=')[0]
  return name.startsWith('--') && name.length >= min && full.startsWith(name)
}

function hasLong(argv: readonly string[], full: string, min = 4): boolean {
  return argv.some((arg) => longPrefix(arg, full, min))
}

function skipOptions(argv: readonly string[], start: number, withValue: ReadonlySet<string>): number {
  let i = start
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--') return i + 1
    if (!arg.startsWith('-') || arg === '-') return i
    if (withValue.has(arg)) i += 2
    else i += 1
  }
  return i
}

const SED_E_COMMAND = /(^|[;\n{}])\s*[0-9$,/!]*\s*e(\s|$)/
const SED_E_FLAG = /^s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[a-zA-Z0-9]*e/

class Analysis {
  readonly reasons = new Set<string>()
  readonly commands: string[] = []
  private readonly ctx: ClassifyContext
  private readonly piped = new Set<number>()

  constructor(ctx: ClassifyContext) {
    this.ctx = ctx
  }

  walk(node: Node): void {
    if (node.type === 'ERROR' || node.isMissing) this.reasons.add(REASON.unparseable)
    else if (node.type === 'command_substitution') this.reasons.add(REASON.substitution)
    else if (node.type === 'process_substitution') this.reasons.add(REASON.processSubstitution)
    else if (node.type === 'heredoc_redirect' || node.type === 'herestring_redirect') this.reasons.add(REASON.heredoc)
    else if (CONTROL_FLOW.has(node.type)) this.reasons.add(REASON.controlFlow)
    else if (node.type === 'file_redirect' && !isAllowedRedirect(node)) this.reasons.add(REASON.redirection)
    else if (node.type === 'variable_assignment') this.assignment(node)
    else if (node.type === 'command') this.command(node)
    else if (node.type === 'pipeline') this.pipeline(node)
    for (const child of node.namedChildren) if (child) this.walk(child)
  }

  private assignment(node: Node): void {
    const name = node.childForFieldName('name')?.text ?? ''
    if (SENSITIVE_VARS.test(name)) this.reasons.add(REASON.envOverride)
    const value = node.childForFieldName('value')
    if (value && staticText(value) === null && value.type !== 'array') this.reasons.add(REASON.dynamicArg)
  }

  private pipeline(node: Node): void {
    const stages = node.namedChildren.filter((c): c is Node => c !== null)
    for (const stage of stages.slice(1)) {
      const command = stage.type === 'command' ? stage : stage.namedChildren.find((c) => c?.type === 'command')
      if (command) this.piped.add(command.id)
    }
  }

  private command(node: Node): void {
    const nameNode = node.childForFieldName('name')
    if (!nameNode) return
    const name = staticText(nameNode)
    if (name === null) {
      this.reasons.add(REASON.dynamicName)
      this.commands.push(nameNode.text)
      return
    }
    if (hasGlob(nameNode) || hasBraceExpansion(nameNode)) this.reasons.add(REASON.globName)
    const argv = [name]
    for (const arg of node.childrenForFieldName('argument')) {
      if (!arg) continue
      const text = staticText(arg)
      if (text === null) {
        this.reasons.add(REASON.dynamicArg)
        continue
      }
      if (hasBraceExpansion(arg)) this.reasons.add(REASON.dynamicArg)
      if (text.startsWith('-') && hasGlob(arg)) this.reasons.add(REASON.globFlag)
      argv.push(text)
    }
    this.argv(argv, 0, this.piped.has(node.id))
  }

  private unwrap(argv: readonly string[], index: number, depth: number, piped: boolean): void {
    if (index < argv.length) this.argv(argv.slice(index), depth + 1, piped)
  }

  argv(argv: readonly string[], depth: number, piped: boolean): void {
    if (argv.length === 0 || depth > 8) return
    const name = basename(argv[0])
    this.commands.push(name)
    const args = argv.slice(1)
    this.paths(args)
    const r = this.reasons
    if (piped && isInterpreter(name)) r.add(REASON.pipeInterpreter)

    switch (name) {
      case 'eval':
      case 'exec':
      case 'source':
      case '.':
      case 'fc':
        r.add(REASON.eval)
        return
      case 'trap':
      case 'alias':
      case 'bind':
      case 'complete':
      case 'enable':
        r.add(REASON.deferred)
        return
      case 'set':
        if (args.some((a) => /^[-+][A-Za-z]*H/.test(a) || a === 'history' || a === 'histexpand')) {
          r.add(REASON.shellOption)
        }
        return
      case 'shopt':
        if (args.includes('-s') || args.includes('-u')) r.add(REASON.shellOption)
        return
      case 'cd':
      case 'pushd':
        if (positionals(args).length === 0 || args.includes('-')) r.add(REASON.outsideRoot)
        return
      case 'sudo':
      case 'doas':
      case 'pkexec':
      case 'run0':
        r.add(REASON.privilege)
        this.unwrap(
          argv,
          skipOptions(argv, 1, new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-T', '-r', '-t', '--user'])),
          depth,
          piped,
        )
        return
      case 'su':
      case 'sudoedit':
        r.add(REASON.privilege)
        return
      case 'xargs':
        r.add(REASON.wrapper)
        this.unwrap(
          argv,
          skipOptions(argv, 1, new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '-J', '-R', '-S'])),
          depth,
          piped,
        )
        return
      case 'env': {
        if (args.some((a) => /^-[A-Za-z]*S/.test(a) && !a.startsWith('--')) || hasLong(args, '--split-string', 3)) {
          r.add(REASON.inlineCode)
        }
        let i = skipOptions(argv, 1, new Set(['-u', '-C', '-P', '--unset', '--chdir']))
        while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
          if (SENSITIVE_VARS.test(argv[i].split('=')[0])) r.add(REASON.envOverride)
          i++
        }
        if (i < argv.length) {
          r.add(REASON.wrapper)
          this.unwrap(argv, i, depth, piped)
        }
        return
      }
      case 'nohup':
      case 'time':
      case 'coproc':
        r.add(REASON.wrapper)
        this.unwrap(argv, skipOptions(argv, 1, new Set()), depth, piped)
        return
      case 'command':
      case 'builtin':
        if (args.some((a) => a === '-v' || a === '-V')) return
        r.add(REASON.wrapper)
        this.unwrap(argv, skipOptions(argv, 1, new Set()), depth, piped)
        return
      case 'nice':
      case 'ionice':
      case 'stdbuf':
      case 'caffeinate':
      case 'arch':
        this.unwrap(
          argv,
          skipOptions(argv, 1, new Set(['-n', '-c', '-p', '-i', '-o', '-e', '-t', '-w', '--adjustment', '--class'])),
          depth,
          piped,
        )
        return
      case 'chrt':
      case 'taskset': {
        const i = skipOptions(argv, 1, new Set())
        this.unwrap(argv, i + 1, depth, piped)
        return
      }
      case 'timeout':
      case 'gtimeout': {
        const i = skipOptions(argv, 1, new Set(['-s', '-k', '--signal', '--kill-after']))
        this.unwrap(argv, i + 1, depth, piped)
        return
      }
      case 'busybox':
      case 'toybox':
        this.unwrap(argv, 1, depth, piped)
        return
      case 'setsid':
      case 'daemonize':
      case 'start-stop-daemon':
      case 'tmux':
      case 'screen':
      case 'disown':
        r.add(REASON.detaches)
        return
      case 'at':
      case 'batch':
        r.add(REASON.scheduledJob)
        return
      case 'watch':
        r.add(REASON.inlineCode)
        return
      case 'script':
        if (/c/.test(shortFlags(leadingOptions(args))) || hasLong(args, '--command')) r.add(REASON.inlineCode)
        return
      case 'rm': {
        const flags = shortFlags(args)
        if (/[rR]/.test(flags) || hasLong(args, '--recursive', 3)) r.add(REASON.recursiveDelete)
        else if (flags.includes('f') || hasLong(args, '--force', 3)) r.add(REASON.forcedDelete)
        return
      }
      case 'dd':
      case 'fdisk':
      case 'diskutil':
      case 'parted':
      case 'wipefs':
        r.add(REASON.disk)
        return
      case 'chmod':
      case 'chown':
      case 'chgrp':
        if (shortFlags(args).includes('R') || hasLong(args, '--recursive', 3)) r.add(REASON.recursivePermissions)
        return
      case 'kill':
      case 'pkill':
      case 'killall':
        r.add(REASON.killsProcesses)
        return
      case 'shutdown':
      case 'reboot':
      case 'halt':
      case 'poweroff':
      case 'launchctl':
      case 'systemctl':
        r.add(REASON.systemControl)
        return
      case 'git':
        this.git(args)
        return
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun': {
        const pos = positionals(args)
        if (pos.slice(0, 2).some((a) => a === 'publish' || a === 'unpublish')) r.add(REASON.publish)
        if (pos[0] === 'login' || pos[0] === 'adduser' || pos[0] === 'token') r.add(REASON.registryLogin)
        if (name === 'bun' && args.some((a) => a === '-e' || longPrefix(a, '--eval', 3))) r.add(REASON.inlineCode)
        if (pos[0] === 'exec' || pos[0] === 'x' || pos[0] === 'dlx') {
          if (args.some((a) => a === '-c' || longPrefix(a, '--call', 3))) {
            r.add(REASON.inlineCode)
            return
          }
          const sub = args.indexOf(pos[0])
          this.unwrap(args, skipOptions(args, sub + 1, new Set(['--package', '-p'])), depth, piped)
        }
        return
      }
      case 'npx':
      case 'pnpx':
      case 'bunx':
        if (args.some((a) => a === '-c' || longPrefix(a, '--call', 3))) {
          r.add(REASON.inlineCode)
          return
        }
        this.unwrap(argv, skipOptions(argv, 1, new Set(['--package', '-p'])), depth, piped)
        return
      case 'ssh':
      case 'scp':
      case 'sftp':
        r.add(REASON.remote)
        return
      case 'rsync':
        if (args.some((a) => !a.startsWith('-') && /^[^/.][^/]*:/.test(a))) r.add(REASON.remote)
        if (/e/.test(shortFlags(args)) || hasLong(args, '--rsh', 3)) r.add(REASON.inlineCode)
        return
      case 'nc':
      case 'ncat':
      case 'netcat':
      case 'socat':
      case 'telnet':
        r.add(REASON.rawNetwork)
        return
      case 'curl':
        if (this.curlUploads(args)) r.add(REASON.upload)
        return
      case 'wget':
        if (hasLong(args, '--post-file') || hasLong(args, '--body-file')) r.add(REASON.upload)
        return
      case 'find':
        if (args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf'].includes(a))) {
          r.add(REASON.findExec)
        }
        return
      case 'tar':
      case 'gtar':
      case 'bsdtar':
        if (
          ['--checkpoint-action', '--use-compress-program', '--to-command', '--info-script', '--new-volume-script', '--rsh-command'].some(
            (full) => hasLong(args, full, 6),
          ) ||
          args.includes('-I')
        ) {
          r.add(REASON.inlineCode)
        }
        return
      case 'sed':
      case 'gsed':
        if (positionals(args).some((a) => SED_E_COMMAND.test(a) || SED_E_FLAG.test(a))) r.add(REASON.inlineCode)
        return
      case 'crontab':
        if (!args.includes('-l')) r.add(REASON.scheduledJob)
        return
      case 'awk':
      case 'gawk':
      case 'mawk':
      case 'nawk':
        if (args.some((a) => /system\s*\(|\|\s*getline|\|\s*"/.test(a) || /print[^;]*\|/.test(a))) {
          r.add(REASON.inlineCode)
        }
        return
    }

    if (/^mkfs/.test(name) || /^newfs/.test(name)) {
      r.add(REASON.disk)
      return
    }
    const leading = leadingOptions(args)
    if (SHELLS.has(name)) {
      if (/c/i.test(shortFlags(leading)) || hasLong(leading, '--command', 3)) r.add(REASON.inlineCode)
      else if (!piped && positionals(args).length === 0 && !leading.some((a) => a === '--version' || a === '--help')) {
        r.add(REASON.startsShell)
      }
      return
    }
    if (PYTHON.test(name)) {
      if (/c/.test(shortFlags(leading))) r.add(REASON.inlineCode)
      return
    }
    const inline = INLINE_FLAGS[name]
    if (inline && (inline.test(shortFlags(leading)) || hasLong(leading, '--eval', 3) || hasLong(leading, '--print', 3))) {
      r.add(REASON.inlineCode)
    }
    if (name === 'deno' && args[0] === 'eval') r.add(REASON.inlineCode)
  }

  private curlUploads(args: readonly string[]): boolean {
    return args.some((a, i) => {
      const next = args[i + 1] ?? ''
      if (isShortCluster(a)) {
        const letters = a.slice(1)
        if (letters.includes('T')) return true
        const d = letters.search(/[dF]/)
        if (d >= 0) {
          const attached = letters.slice(d + 1)
          const value = attached.length > 0 ? attached : next
          return letters[d] === 'd' ? value.startsWith('@') : /=[@<]/.test(value)
        }
        return false
      }
      if (hasLong([a], '--upload-file', 4)) return true
      const name = a.split('=')[0]
      if (name.startsWith('--data') || name === '--json') {
        const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : next
        return value.startsWith('@')
      }
      if (name.startsWith('--form')) {
        const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : next
        return /=[@<]/.test(value)
      }
      return false
    })
  }

  private git(args: readonly string[]): void {
    const r = this.reasons
    const i = skipOptions(args, 0, new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']))
    const globals = args.slice(0, i)
    if (globals.some((a) => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path'))) {
      r.add(REASON.envOverride)
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    const flags = shortFlags(rest)
    switch (sub) {
      case 'push':
        if (
          hasLong(rest, '--force', 5) ||
          hasLong(rest, '--force-with-lease', 8) ||
          hasLong(rest, '--mirror', 4) ||
          flags.includes('f') ||
          rest.some((a) => !a.startsWith('-') && a.startsWith('+'))
        ) {
          r.add(REASON.forcePush)
        }
        if (hasLong(rest, '--delete', 4) || flags.includes('d') || rest.some((a) => /^:[^:]/.test(a))) {
          r.add(REASON.remoteDelete)
        }
        return
      case 'reset':
        if (hasLong(rest, '--hard', 4)) r.add(REASON.hardReset)
        return
      case 'clean':
        if (flags.includes('f') || hasLong(rest, '--force', 4)) r.add(REASON.gitClean)
        return
      case 'filter-branch':
      case 'filter-repo':
        r.add(REASON.historyRewrite)
        return
      case 'rebase':
        if (flags.includes('x') || hasLong(rest, '--exec', 4)) r.add(REASON.inlineCode)
        return
      case 'submodule':
        if (rest.includes('foreach')) r.add(REASON.inlineCode)
        return
      case 'bisect':
        if (rest[0] === 'run') r.add(REASON.inlineCode)
        return
      case 'config': {
        const readOnly = rest.some((a) =>
          ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--get-urlmatch'].includes(a),
        )
        if (!readOnly && positionals(rest).length >= 2) r.add(REASON.gitConfig)
        if (positionals(rest)[0] === 'set' || rest.includes('--add') || rest.includes('--replace-all')) {
          r.add(REASON.gitConfig)
        }
        return
      }
    }
  }

  private paths(args: readonly string[]): void {
    for (const arg of args) {
      const candidates = [arg]
      const eq = arg.indexOf('=')
      if (arg.startsWith('-') && eq > 0) candidates.push(arg.slice(eq + 1))
      for (const candidate of candidates) {
        if (SAFE_PATHS.has(candidate)) continue
        const pathLike =
          candidate.startsWith('/') ||
          candidate.startsWith('~') ||
          candidate === '..' ||
          candidate.startsWith('../') ||
          candidate.includes('/../') ||
          candidate.endsWith('/..')
        if (pathLike && leavesRoot(this.ctx.root, this.ctx.home, candidate)) {
          this.reasons.add(REASON.outsideRoot)
        }
      }
    }
  }
}

export function classify(command: string, ctx: ClassifyContext): Classification {
  if (command.trim() === '') return { sensitive: false, reasons: [], commands: [] }
  if (!parser) return { sensitive: true, reasons: ['classifier unavailable'], commands: [] }
  const tree = parser.parse(command)
  if (!tree) return { sensitive: true, reasons: [REASON.unparseable], commands: [] }
  try {
    const analysis = new Analysis(ctx)
    if (tree.rootNode.hasError) analysis.reasons.add(REASON.unparseable)
    analysis.walk(tree.rootNode)
    const reasons = [...analysis.reasons]
    return { sensitive: reasons.length > 0, reasons, commands: [...new Set(analysis.commands)] }
  } finally {
    tree.delete()
  }
}
