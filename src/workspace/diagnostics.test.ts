import { describe, expect, it } from 'vitest'
import {
  collectLocalRefs,
  diagnoseContent,
  resolveLocalRef,
} from './diagnostics'

describe('diagnoseContent', () => {
  it('accepts balanced HTML and a valid inline script', () => {
    const result = diagnoseContent('index.html', '<div><script>const a = 1</script></div>')
    expect(result.kind).toBe('html')
    expect(result.errors).toEqual([])
  })

  it('reports an unclosed non-optional element', () => {
    const result = diagnoseContent('index.html', '<div><span>hi</div>')
    const messages = result.errors.map((error) => error.message)
    expect(messages.some((message) => message.includes('<span> is never closed'))).toBe(true)
  })

  it('does not flag omitted end tags for optional-close elements', () => {
    expect(diagnoseContent('index.html', '<ul><li>a<li>b</ul>').errors).toEqual([])
    expect(diagnoseContent('index.html', '<div><p>hi</div>').errors).toEqual([])
  })

  it('treats inline tags inside a p as valid', () => {
    expect(
      diagnoseContent('index.html', '<p>Call <code>run()</code> to start.</p>').errors,
    ).toEqual([])
    expect(
      diagnoseContent('index.html', '<p><a href="x"><strong>link</strong></a> and text</p>').errors,
    ).toEqual([])
  })

  it('closes p on a block-level start tag but not on inline tags', () => {
    expect(diagnoseContent('index.html', '<p>a<div>b</div>').errors).toEqual([])
  })

  it('treats a bare less-than in pre as text', () => {
    expect(diagnoseContent('index.html', '<pre>if (a < b) run()</pre>').errors).toEqual([])
  })

  it('ignores tags inside comments', () => {
    expect(diagnoseContent('index.html', '<!-- <div> --><span></span>').errors).toEqual([])
  })

  it('does not scan markup inside textarea bodies', () => {
    expect(diagnoseContent('index.html', '<textarea><b></textarea>').errors).toEqual([])
  })

  it('reports a closing tag with no open tag', () => {
    const result = diagnoseContent('index.html', '<div></span></div>')
    expect(result.errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining('Unexpected closing </span>'),
    )
  })

  it('reports invalid inline script syntax', () => {
    const result = diagnoseContent('index.html', '<script>const = ;</script>')
    expect(result.errors.some((error) => error.message.includes('JavaScript syntax error'))).toBe(true)
  })

  it('skips module scripts instead of producing a false positive', () => {
    const result = diagnoseContent('index.html', '<script type="module">import x from "y"</script>')
    expect(result.errors).toEqual([])
  })

  it('reports invalid JSON with the parse message', () => {
    const result = diagnoseContent('data.json', '{ "a": }')
    expect(result.kind).toBe('json')
    expect(result.errors[0].message).toContain('JSON parse error')
  })

  it('returns no diagnostics for plain text', () => {
    expect(diagnoseContent('notes.txt', 'anything')).toMatchObject({ errors: [], warnings: [] })
  })
})

describe('local references', () => {
  it('collects relative refs and drops remote, anchor, and absolute ones', () => {
    const html =
      '<link href="style.css"><script src="./app.js"></script><img src="https://x/y.png"><a href="#top"></a>'
    expect(collectLocalRefs(html)).toEqual(['style.css', './app.js'])
  })

  it('ignores ref-shaped strings inside inline scripts and comments', () => {
    const html =
      '<script>const a = \'<img src="ghost.png">\'</script><!-- <img src="c.png"> --><img src="real.png">'
    expect(collectLocalRefs(html)).toEqual(['real.png'])
  })

  it('resolves a ref against the file directory and strips a query', () => {
    expect(resolveLocalRef('pages/index.html', './app.js?v=2')).toBe('pages/app.js')
    expect(resolveLocalRef('index.html', 'assets/logo.png')).toBe('assets/logo.png')
  })

  it('refuses a ref that escapes the workspace root', () => {
    expect(resolveLocalRef('index.html', '../../etc/passwd')).toBeNull()
  })
})
