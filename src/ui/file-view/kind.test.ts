import { describe, expect, it } from 'vitest'
import {
  absoluteHttpUrl,
  extensionOf,
  kindForExtension,
  kindForPath,
  kindForRemote,
  kindForTarget,
  kindLabel,
  normalizeRemoteInput,
} from './kind'

describe('extensionOf', () => {
  it('lower-cases and ignores query and fragment', () => {
    expect(extensionOf('docs/Report.PDF?download=1')).toBe('pdf')
    expect(extensionOf('https://x.test/a/Img.PNG#frag')).toBe('png')
  })

  it('returns empty for names with no extension or a leading dot', () => {
    expect(extensionOf('https://x.test/')).toBe('')
    expect(extensionOf('LICENSE')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('kindForExtension', () => {
  it('maps every supported family', () => {
    expect(kindForExtension('png')).toBe('image')
    expect(kindForExtension('svg')).toBe('image')
    expect(kindForExtension('mp3')).toBe('audio')
    expect(kindForExtension('mp4')).toBe('video')
    expect(kindForExtension('html')).toBe('html')
    expect(kindForExtension('csv')).toBe('csv')
    expect(kindForExtension('tsv')).toBe('csv')
    expect(kindForExtension('xlsx')).toBe('spreadsheet')
    expect(kindForExtension('docx')).toBe('docx')
    expect(kindForExtension('md')).toBe('markdown')
    expect(kindForExtension('markdown')).toBe('markdown')
    expect(kindForExtension('json')).toBe('json')
    expect(kindForExtension('jsonc')).toBeNull()
    expect(kindForExtension('mmd')).toBe('diagram')
    expect(kindForExtension('mermaid')).toBe('diagram')
  })
})

describe('kindForPath and kindForRemote', () => {
  it('keeps unknown workspace files editable and unknown links embedded', () => {
    expect(kindForPath('src/index.ts')).toBe('text')
    expect(kindForPath('README')).toBe('text')
    expect(kindForPath('photo.jpeg')).toBe('image')
    expect(kindForRemote('https://x.test/notes.md')).toBe('markdown')
    expect(kindForRemote('https://x.test/data.json')).toBe('json')
    expect(kindForRemote('https://x.test/')).toBe('embed')
    expect(kindForRemote('https://x.test/photo.webp')).toBe('image')
    expect(kindForRemote('https://x.test/data.xlsx')).toBe('spreadsheet')
  })

  it('routes each target shape to its kind and label', () => {
    expect(kindForTarget({ kind: 'workspace', path: 'a/b.docx' })).toBe('docx')
    expect(kindForTarget({ kind: 'url', url: 'https://x.test/a.mp4' })).toBe('video')
    expect(kindLabel('spreadsheet')).toBe('Sheet')
    expect(kindLabel('markdown')).toBe('Markdown')
    expect(kindLabel('json')).toBe('JSON')
    expect(kindLabel('diagram')).toBe('Diagram')
    expect(kindLabel('embed')).toBe('Link')
  })
})

describe('normalizeRemoteInput', () => {
  it('adds https to bare hosts and keeps explicit http(s) links', () => {
    expect(normalizeRemoteInput('example.com/a.png')).toBe('https://example.com/a.png')
    expect(normalizeRemoteInput('http://example.com/a')).toBe('http://example.com/a')
    expect(normalizeRemoteInput('//example.com/a')).toBe('https://example.com/a')
  })

  it('treats host:port as a bare host, not a scheme', () => {
    expect(normalizeRemoteInput('localhost:3000/report.csv')).toBe(
      'https://localhost:3000/report.csv',
    )
  })

  it('rejects empty, foreign-scheme, and unparseable input', () => {
    expect(normalizeRemoteInput('')).toBeNull()
    expect(normalizeRemoteInput('   ')).toBeNull()
    expect(normalizeRemoteInput('javascript:alert(1)')).toBeNull()
    expect(normalizeRemoteInput('data:text/html,<h1>x</h1>')).toBeNull()
    expect(normalizeRemoteInput('ftp://example.com/a')).toBeNull()
  })
})

describe('absoluteHttpUrl', () => {
  it('accepts absolute and protocol-relative http(s) hrefs', () => {
    expect(absoluteHttpUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(absoluteHttpUrl('//example.com/a')).toBe('https://example.com/a')
  })

  it('rejects relative, mailto, and scriptable hrefs', () => {
    expect(absoluteHttpUrl('/relative/a.png')).toBeNull()
    expect(absoluteHttpUrl('./a.png')).toBeNull()
    expect(absoluteHttpUrl('mailto:a@b.test')).toBeNull()
    expect(absoluteHttpUrl('javascript:alert(1)')).toBeNull()
    expect(absoluteHttpUrl(undefined)).toBeNull()
  })
})
