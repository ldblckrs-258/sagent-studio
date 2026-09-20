import { describe, expect, it } from 'vitest'
import { isCatastrophicPattern, probeBinary, runSearch, scanText } from './search'
import type { SearchFsCall } from './search'
import type { SearchRequest } from './search-protocol'

function fsCall(initial: Record<string, string>, oversized: Set<string> = new Set()): SearchFsCall {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>([''])
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  return async (op, path) => {
    if (op === 'read') {
      if (oversized.has(path)) throw new Error('The workspace entry exceeds the size cap.')
      const content = files.get(path)
      if (content === undefined) throw new Error('No workspace entry exists.')
      return content
    }
    const prefix = path === '' ? '' : `${path}/`
    const entries: Array<{ name: string; path: string; kind: string }> = []
    for (const dir of dirs) {
      if (dir === '' || dir === path) continue
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
        entries.push({ name: dir.slice(prefix.length), path: dir, kind: 'directory' })
      }
    }
    for (const file of files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
        entries.push({ name: file.slice(prefix.length), path: file, kind: 'file' })
      }
    }
    return JSON.stringify(entries)
  }
}

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    pattern: 'world',
    flags: '',
    rootPath: '',
    maxResults: 100,
    maxFilesScanned: 2000,
    maxDepth: 20,
    ...overrides,
  }
}

describe('probeBinary', () => {
  it('detects a NUL byte in the probe window', () => {
    expect(probeBinary('abc\u0000def')).toBe(true)
    expect(probeBinary('plain text')).toBe(false)
    expect(probeBinary(`${'a'.repeat(9000)}\u0000`)).toBe(false)
  })
})

describe('isCatastrophicPattern', () => {
  it('rejects nested quantifiers and backreferences', () => {
    expect(isCatastrophicPattern('(a+)+')).toBe(true)
    expect(isCatastrophicPattern('(.*)*')).toBe(true)
    expect(isCatastrophicPattern('(\\w+)\\1')).toBe(true)
  })

  it('accepts ordinary patterns', () => {
    expect(isCatastrophicPattern('foo|bar')).toBe(false)
    expect(isCatastrophicPattern('TODO')).toBe(false)
    expect(isCatastrophicPattern('(ab)+')).toBe(false)
  })
})

describe('scanText', () => {
  it('finds every matching line with 1-based line numbers', () => {
    const matcher = new RegExp('world')
    expect(scanText('hello world\nnothing\nworld again', matcher, 10)).toEqual({
      hits: [
        { line: 1, text: 'hello world' },
        { line: 3, text: 'world again' },
      ],
      truncated: false,
    })
  })

  it('respects maxResults and reports truncation', () => {
    const matcher = new RegExp('a')
    const result = scanText('a\na\na\n', matcher, 2)
    expect(result.hits).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('truncates a long hit text to 400 characters', () => {
    const line = `x${'y'.repeat(500)}`
    const matcher = new RegExp('x')
    const result = scanText(line, matcher, 10)
    expect(result.hits[0].text).toHaveLength(400)
  })

  it('does not match across line boundaries', () => {
    const matcher = new RegExp('foo\\nbar')
    expect(scanText('foo\nbar', matcher, 10).hits).toEqual([])
  })
})

describe('runSearch', () => {
  it('walks a tree and returns root-relative hits', async () => {
    const result = await runSearch(
      fsCall({ 'root/a.txt': 'hello world', 'root/sub/b.ts': 'world' }),
      request(),
    )
    expect(result.hits).toEqual([
      { path: 'root/a.txt', line: 1, text: 'hello world' },
      { path: 'root/sub/b.ts', line: 1, text: 'world' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('scans only the requested subtree', async () => {
    const result = await runSearch(
      fsCall({ 'root/a.txt': 'world', 'root/sub/b.txt': 'world' }),
      request({ rootPath: 'root/sub' }),
    )
    expect(result.hits.map((hit) => hit.path)).toEqual(['root/sub/b.txt'])
  })

  it('counts an oversized file in filesSkipped without failing', async () => {
    const result = await runSearch(
      fsCall({ 'root/big.txt': 'world', 'root/small.txt': 'world' }, new Set(['root/big.txt'])),
      request(),
    )
    expect(result.filesSkipped).toBe(1)
    expect(result.hits.map((hit) => hit.path)).toEqual(['root/small.txt'])
  })

  it('skips a NUL-byte file and still returns hits from text files', async () => {
    const result = await runSearch(
      fsCall({ 'root/bin.txt': 'a\u0000world', 'root/a.txt': 'world' }),
      request(),
    )
    expect(result.filesSkipped).toBe(1)
    expect(result.hits.map((hit) => hit.path)).toEqual(['root/a.txt'])
  })

  it('stops at maxResults and reports truncation', async () => {
    const result = await runSearch(
      fsCall({ 'root/a.txt': 'world', 'root/b.txt': 'world' }),
      request({ maxResults: 1 }),
    )
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('stops at maxFilesScanned and reports truncation', async () => {
    const result = await runSearch(
      fsCall({ 'root/a.txt': 'world', 'root/b.txt': 'world' }),
      request({ maxFilesScanned: 1 }),
    )
    expect(result.truncated).toBe(true)
  })

  it('stops at maxDepth and reports truncation', async () => {
    const result = await runSearch(fsCall({ 'a/b/c.txt': 'world' }), request({ maxDepth: 0 }))
    expect(result.hits).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('rejects a catastrophic pattern before scanning', async () => {
    await expect(runSearch(fsCall({}), request({ pattern: '(a+)+' }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('rejects an invalid pattern', async () => {
    await expect(runSearch(fsCall({}), request({ pattern: '(' }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})
