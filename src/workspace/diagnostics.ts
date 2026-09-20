/**
 * Lightweight, dependency-free structural checks for workspace artifacts. The
 * goal is to give a model a machine-readable verdict about a file it just wrote
 * (unbalanced HTML, broken `<script>` syntax, invalid JSON, dangling local
 * references) without a real browser render.
 */
export interface Diagnostic {
  line?: number
  message: string
}

export interface FileDiagnostics {
  kind: string
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Elements whose body is not markup (so tags inside are not scanned). */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

/** Start tags that implicitly close an open `<p>` (HTML5 block-level list). */
const P_CLOSED_BY = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])

/**
 * Optional-end-tag elements keyed by the start tag that implicitly closes them.
 * Only tags listed here auto-close; inline tags like `<code>` inside `<p>` do
 * not, which is what the naive "any open tag closes an optional top" got wrong.
 */
const AUTO_CLOSE: Record<string, ReadonlySet<string>> = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
  tr: new Set(['tr', 'td', 'th']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  thead: new Set(['colgroup']),
  tbody: new Set(['colgroup', 'thead', 'tbody', 'tfoot']),
  tfoot: new Set(['colgroup', 'thead', 'tbody', 'tfoot']),
}

/** Elements whose end tag may be omitted entirely. */
const OPTIONAL_CLOSE = new Set(['p', ...Object.keys(AUTO_CLOSE)])

function startTagClosesOptional(open: string, top: string): boolean {
  if (top === 'p') return P_CLOSED_BY.has(open)
  return AUTO_CLOSE[open]?.has(top) === true
}

const TAG_PATTERN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g

export function extensionOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined
}

function lineAt(content: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function checkJavaScript(source: string): Diagnostic[] {
  // `new Function` parses a non-module JS body; module syntax would throw a
  // false positive, so leave it to the browser instead of a bogus error.
  if (/\b(?:import|export)\b/.test(source)) return []
  try {
    new Function(source)
    return []
  } catch (error) {
    return [{ message: `JavaScript syntax error: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

function checkHtml(content: string): FileDiagnostics {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  const stack: Array<{ name: string; line: number }> = []
  let match: RegExpExecArray | null

  while ((match = TAG_PATTERN.exec(content)) !== null) {
    const raw = match[0]
    if (raw.startsWith('<!--')) continue
    const name = match[1].toLowerCase()
    const closing = raw.startsWith('</')
    const selfClosing = match[3] === '/'

    if (RAW_TEXT_ELEMENTS.has(name) && !closing) {
      const closeIndex = content.toLowerCase().indexOf(`</${name}`, TAG_PATTERN.lastIndex)
      const bodyEnd = closeIndex === -1 ? content.length : closeIndex
      const body = content.slice(TAG_PATTERN.lastIndex, bodyEnd)
      if (name === 'script' && !/\ssrc\s*=/.test(raw)) {
        for (const diagnostic of checkJavaScript(body)) {
          errors.push({ ...diagnostic, line: lineAt(content, TAG_PATTERN.lastIndex) })
        }
      }
      if (closeIndex === -1) {
        const line = lineAt(content, match.index)
        errors.push({ line, message: `<${name}> is never closed.` })
        TAG_PATTERN.lastIndex = content.length
        continue
      }
      // Skip past the matching closer; the raw-text block is consumed whole.
      TAG_PATTERN.lastIndex = closeIndex + `</${name}`.length
      continue
    }

    if (closing) {
      if (VOID_ELEMENTS.has(name)) {
        warnings.push({ line: lineAt(content, match.index), message: `</${name}> closes a void element.` })
        continue
      }
      if (RAW_TEXT_ELEMENTS.has(name)) continue
      const top = stack[stack.length - 1]
      if (!top) {
        errors.push({ line: lineAt(content, match.index), message: `Unexpected closing </${name}> with no open tag.` })
        continue
      }
      if (top.name === name) {
        stack.pop()
        continue
      }
      const matchIndex = [...stack].reverse().findIndex((entry) => entry.name === name)
      if (matchIndex === -1) {
        errors.push({
          line: lineAt(content, match.index),
          message: `Unexpected closing </${name}> with no open tag.`,
        })
        continue
      }
      // An end tag may omit the end tags of optional-close elements above it.
      let allOptional = true
      for (let cursor = stack.length - 1; cursor > stack.length - 1 - matchIndex; cursor -= 1) {
        if (!OPTIONAL_CLOSE.has(stack[cursor].name)) {
          allOptional = false
          break
        }
      }
      if (!allOptional) {
        for (let cursor = stack.length - 1; cursor > stack.length - 1 - matchIndex; cursor -= 1) {
          errors.push({ line: stack[cursor].line, message: `<${stack[cursor].name}> is never closed.` })
        }
        errors.push({
          line: lineAt(content, match.index),
          message: `</${name}> closed before <${top.name}> (opened on line ${top.line}).`,
        })
      }
      stack.length -= matchIndex + 1
      continue
    }

    if (VOID_ELEMENTS.has(name) || selfClosing) continue
    while (stack.length > 0 && startTagClosesOptional(name, stack[stack.length - 1].name)) {
      stack.pop()
    }
    stack.push({ name, line: lineAt(content, match.index) })
  }

  for (const open of stack) {
    if (OPTIONAL_CLOSE.has(open.name)) continue
    errors.push({ line: open.line, message: `<${open.name}> is never closed.` })
  }

  return { kind: 'html', errors, warnings }
}

function checkJson(content: string): FileDiagnostics {
  try {
    JSON.parse(content)
    return { kind: 'json', errors: [], warnings: [] }
  } catch (error) {
    return {
      kind: 'json',
      errors: [{ message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}` }],
      warnings: [],
    }
  }
}

export function diagnoseContent(path: string, content: string): FileDiagnostics {
  switch (extensionOf(path)) {
    case 'html':
    case 'htm':
      return checkHtml(content)
    case 'json':
      return checkJson(content)
    case 'js':
    case 'mjs':
    case 'cjs':
      return { kind: 'javascript', errors: checkJavaScript(content), warnings: [] }
    case 'mmd':
    case 'mermaid':
      return {
        kind: 'mermaid',
        errors: content.trim().length === 0 ? [{ message: 'The diagram is empty.' }] : [],
        warnings: [],
      }
    default:
      return { kind: 'text', errors: [], warnings: [] }
  }
}

const LOCAL_REF_PATTERN = /(?:src|href)\s*=\s*["']([^"']+)["']/gi
const REMOTE_PREFIXES = ['http://', 'https://', '//', 'data:', 'mailto:', 'tel:', '#', '/']

export function collectLocalRefs(content: string): string[] {
  // Comments and inline script/style bodies can hold `src=`-shaped strings that
  // are not markup references. Keep each element's opening tag (so a
  // `<script src>` is still validated) and drop only the body.
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (element) => {
      const openEnd = element.indexOf('>')
      return openEnd === -1 ? ' ' : element.slice(0, openEnd + 1)
    })
  const refs = new Set<string>()
  let match: RegExpExecArray | null
  LOCAL_REF_PATTERN.lastIndex = 0
  while ((match = LOCAL_REF_PATTERN.exec(stripped)) !== null) {
    const ref = match[1].trim()
    if (ref.length === 0) continue
    if (REMOTE_PREFIXES.some((prefix) => ref.toLowerCase().startsWith(prefix))) continue
    refs.add(ref)
  }
  return [...refs]
}

/** Resolves `ref` against the directory of `path`, or null when it escapes the workspace root. */
export function resolveLocalRef(path: string, ref: string): string | null {
  const base = path.split('/').slice(0, -1)
  const queryIndex = ref.search(/[?#]/)
  const clean = queryIndex === -1 ? ref : ref.slice(0, queryIndex)
  if (clean.length === 0) return null
  const segments = [...base, ...clean.split('/')]
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}
