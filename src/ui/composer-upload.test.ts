import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_DROPPED_PATHS,
  MAX_DROPPED_URLS,
  MAX_UPLOAD_BYTES,
  UploadRejectedError,
  acceptInternalPaths,
  fetchUrlIntoWorkspace,
  filenameForUrl,
  parseDropUrls,
  uploadFiles,
} from './composer-upload'
import { useAttachmentStore } from '../chat/attachment-store'
import { createFakeWorkspace } from '../workspace/fake-handle'
import type { WorkspaceFs } from '../workspace/fs'
import { createWorkspaceFs } from '../workspace/fs'
import { createInlineSearchRunner } from '../workspace/search-runner'

function buildFs(initial: Record<string, string> = {}) {
  const fake = createFakeWorkspace(initial)
  const ref: { fs?: WorkspaceFs } = {}
  const searchRunner = createInlineSearchRunner({
    list: (path, options) => (ref.fs as WorkspaceFs).list(path, options),
    readFile: (path) => (ref.fs as WorkspaceFs).readFile(path),
  })
  const fs = createWorkspaceFs(fake.handle, { searchRunner })
  ref.fs = fs
  return fs
}

describe('acceptInternalPaths', () => {
  it('keeps paths that resolve and exist', async () => {
    const fs = buildFs({ 'src/a.ts': 'a', 'src/b.ts': 'b' })
    const result = await acceptInternalPaths(fs, 'src/a.ts\nsrc/b.ts\n')
    expect(result.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.rejected).toBe(0)
  })

  it('rejects a payload larger than the cap without attaching any of it', async () => {
    const fs = buildFs({ 'src/a.ts': 'a' })
    const payload = Array.from({ length: 500 }, () => 'src/a.ts').join('\n')
    const result = await acceptInternalPaths(fs, payload)
    expect(result.paths).toEqual([])
    expect(result.rejected).toBe(500)
  })

  it('rejects traversal and unknown paths, keeping the valid ones', async () => {
    const fs = buildFs({ 'src/a.ts': 'a' })
    const result = await acceptInternalPaths(
      fs,
      '../secret.txt\n/etc/passwd\nmissing.ts\nsrc/a.ts',
    )
    expect(result.paths).toEqual(['src/a.ts'])
    expect(result.rejected).toBe(3)
  })

  it('caps a drop at twenty paths', () => {
    expect(MAX_DROPPED_PATHS).toBe(20)
  })
})

describe('uploadFiles', () => {
  beforeEach(() => {
    useAttachmentStore.setState({ items: {}, autoDisabled: {} })
  })

  it('writes each picked file and suffixes a repeated name', async () => {
    const fs = buildFs()
    await uploadFiles(fs, 't1', [
      new File(['one'], 'a.png', { type: 'image/png' }),
      new File(['two'], 'a.png', { type: 'image/png' }),
    ])

    // Sequential by necessity: probed in parallel, both names would look free.
    const paths = useAttachmentStore.getState().items.t1.map((item) => item.path)
    expect(paths).toEqual(['uploads/a.png', 'uploads/a-1.png'])
    await expect(fs.readFile('uploads/a.png')).resolves.toBe('one')
    await expect(fs.readFile('uploads/a-1.png')).resolves.toBe('two')
  })

  it('sanitizes a hostile picked name before writing it', async () => {
    const fs = buildFs()
    await uploadFiles(fs, 't1', [new File(['x'], '../../etc/pa*sswd')])
    expect(useAttachmentStore.getState().items.t1[0].path).toBe('uploads/passwd')
  })
})

describe('parseDropUrls', () => {
  it('keeps http(s) links from a uri-list and ignores comments and blanks', () => {
    const result = parseDropUrls({
      uriList:
        '# comment\r\n\r\nhttps://example.com/a.png\r\nhttp://example.com/b\r\nhttps://example.com/a.png\r\n',
      html: '',
    })
    expect(result.urls).toEqual([
      'https://example.com/a.png',
      'http://example.com/b',
    ])
    expect(result.rejected).toBe(0)
  })

  it('rejects non-http schemes and relative entries', () => {
    const result = parseDropUrls({
      uriList: 'javascript:alert(1)\ndata:text/plain,x\nfile:///etc/passwd\n/a/relative',
      html: '',
    })
    expect(result.urls).toEqual([])
  })

  it('falls back to the dragged html src or href', () => {
    const result = parseDropUrls({
      uriList: '',
      html: '<img src="https://cdn.example.com/x.png"><a href=\'https://example.com/page\'>x</a>',
    })
    expect(result.urls).toEqual([
      'https://cdn.example.com/x.png',
      'https://example.com/page',
    ])
  })

  it('rejects the whole drop when it carries more than the cap', () => {
    const uriList = Array.from(
      { length: MAX_DROPPED_URLS + 1 },
      (_, index) => `https://example.com/${index}`,
    ).join('\n')
    const result = parseDropUrls({ uriList, html: '' })
    expect(result.urls).toEqual([])
    expect(result.rejected).toBe(MAX_DROPPED_URLS + 1)
  })
})

describe('filenameForUrl', () => {
  it('uses the URL path segment when it has an extension', () => {
    expect(filenameForUrl('https://example.com/pics/photo.png')).toBe('photo.png')
    expect(filenameForUrl('https://example.com/photo.png?w=200#x')).toBe('photo.png')
  })

  it('decodes the segment and ignores a trailing slash', () => {
    expect(filenameForUrl('https://example.com/a%20b/report.pdf')).toBe('report.pdf')
  })

  it('derives an extension from the announced media type', () => {
    expect(filenameForUrl('https://example.com/download', 'image/png')).toBe(
      'download.png',
    )
    expect(filenameForUrl('https://example.com/download', 'text/plain; charset=utf-8')).toBe(
      'download.txt',
    )
  })

  it('falls back to a bare name', () => {
    expect(filenameForUrl('https://example.com/')).toBe('download')
    expect(filenameForUrl('https://example.com/asset', 'application/octet-stream')).toBe(
      'asset',
    )
  })
})

describe('fetchUrlIntoWorkspace', () => {
  beforeEach(() => {
    useAttachmentStore.setState({ items: {}, autoDisabled: {} })
  })

  it('writes the fetched bytes into uploads and adds a chip', async () => {
    const fs = buildFs()
    const fetchImpl = (async () =>
      new Response(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        { status: 200 },
      )) as unknown as typeof fetch

    await fetchUrlIntoWorkspace(fs, 't1', 'https://example.com/pics/photo.png', {
      fetchImpl,
    })

    const item = useAttachmentStore.getState().items.t1[0]
    expect(item.path).toBe('uploads/photo.png')
    expect(item.source).toBe('drag')
    expect(item.bytes).toBe(3)
    await expect(fs.readFile('uploads/photo.png')).resolves.toBe('\u0001\u0002\u0003')
  })

  it('rejects a non-ok response', async () => {
    const fs = buildFs()
    const fetchImpl = (async () =>
      new Response(null, { status: 403 })) as unknown as typeof fetch

    await expect(
      fetchUrlIntoWorkspace(fs, 't1', 'https://example.com/x.png', { fetchImpl }),
    ).rejects.toBeInstanceOf(UploadRejectedError)
  })

  it('reports a blocked cross-origin fetch instead of throwing a raw TypeError', async () => {
    const fs = buildFs()
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(
      fetchUrlIntoWorkspace(fs, 't1', 'https://example.com/x.png', { fetchImpl }),
    ).rejects.toThrow(/could not be fetched/)
  })

  it('refuses an over-limit body before reading it', async () => {
    const fs = buildFs()
    const fetchImpl = (async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
      })) as unknown as typeof fetch

    await expect(
      fetchUrlIntoWorkspace(fs, 't1', 'https://example.com/big.bin', { fetchImpl }),
    ).rejects.toThrow(/upload limit/)
  })

  it('rejects an empty body and writes no file', async () => {
    const fs = buildFs()
    const fetchImpl = (async () =>
      new Response(new Blob([]), { status: 200 })) as unknown as typeof fetch

    await expect(
      fetchUrlIntoWorkspace(fs, 't1', 'https://example.com/empty', { fetchImpl }),
    ).rejects.toThrow(/empty/)
    expect(useAttachmentStore.getState().items.t1).toBeUndefined()
  })
})
