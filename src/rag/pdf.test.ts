import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfDocumentLike } from './pdf'

const pdfState = vi.hoisted(() => ({
  doc: null as unknown,
  getDocumentCalls: 0,
}))

vi.mock('pdfjs-dist/build/pdf.min.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => {
    pdfState.getDocumentCalls += 1
    return { promise: Promise.resolve(pdfState.doc) }
  },
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.min.mjs' }))

import { extractPdfText, extractText, joinTextItems, MAX_EXTRACTED_CHARS, RagExtractionError } from './pdf'

function fakeDoc(pages: string[]): PdfDocumentLike {
  return {
    numPages: pages.length,
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => ({
        items: pages[pageNumber - 1]
          .split(' ')
          .filter(Boolean)
          .map((str) => ({ str })),
      }),
    }),
    destroy: vi.fn(async () => undefined),
  }
}

function textItem(
  str: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  hasEOL = false,
) {
  return { str, transform: [height, 0, 0, height, x, y], width, height, hasEOL }
}

describe('joinTextItems', () => {
  it('merges fragments with no gap and separates fragments past a word gap', () => {
    const items = [
      textItem('tr', 0, 100, 10),
      textItem('ở', 10, 100, 6),
      textItem('lên', 20, 100, 12),
    ]
    expect(joinTextItems(items)).toBe('trở lên')
  })

  it('does not split a syllable at a combining mark, but keeps a real word gap', () => {
    const head = 'cộ'
    expect(joinTextItems([textItem(head, 0, 100, 20), textItem('ng', 22, 100, 12)])).toBe(`${head}ng`)
    const words = [
      textItem('Bộ'.normalize('NFD'), 0, 100, 20),
      textItem('trưởng'.normalize('NFD'), 30, 100, 40),
    ]
    expect(joinTextItems(words)).toBe('Bộ trưởng'.normalize('NFD'))
  })

  it('never starts a word with a detached combining mark', () => {
    const items = [textItem('quy', 0, 100, 18), textItem('\u0300', 40, 100, 4)]
    expect(joinTextItems(items)).toBe('quy\u0300')
  })

  it('starts a new line on hasEOL and on a vertical jump', () => {
    const items = [textItem('one', 0, 100, 12, 10, true), textItem('two', 0, 100, 12)]
    expect(joinTextItems(items)).toBe('one\ntwo')
    expect(joinTextItems([textItem('a', 0, 100, 8), textItem('b', 0, 85, 8)])).toBe('a\nb')
  })

  it('falls back to a single space when geometry is missing', () => {
    expect(joinTextItems([{ str: 'first' }, { str: 'second' }])).toBe('first second')
  })
})

function linedDoc(pages: string[][]): PdfDocumentLike {
  return {
    numPages: pages.length,
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => ({
        items: pages[pageNumber - 1].map((line) => ({ str: line, hasEOL: true })),
      }),
    }),
    destroy: vi.fn(async () => undefined),
  }
}

describe('extractText', () => {
  it('joins page text in page order', async () => {
    const doc = fakeDoc(['first page words', 'second page words'])
    await expect(extractText(doc)).resolves.toBe('first page words\n\nsecond page words')
  })

  it('normalizes detached diacritics back to NFC', async () => {
    const doc = fakeDoc(['quyền của Bộ trưởng'.normalize('NFD')])
    await expect(extractText(doc)).resolves.toBe('quyền của Bộ trưởng')
  })

  it('strips a header that repeats across pages and the page numbers', async () => {
    const doc = linedDoc([
      ['DỰ THẢO', 'Điều 1. Nội dung thứ nhất.', '1'],
      ['DỰ THẢO', 'Điều 2. Nội dung thứ hai.', '2'],
    ])
    await expect(extractText(doc)).resolves.toBe(
      'Điều 1. Nội dung thứ nhất.\n\nĐiều 2. Nội dung thứ hai.',
    )
  })

  it('removes a page number glued to the end of a line', async () => {
    const doc = linedDoc([['quá 36 tháng.”;7', 'c) Bổ sung tiếp']])
    await expect(extractText(doc)).resolves.toBe('quá 36 tháng.”;\nc) Bổ sung tiếp')
  })

  it('keeps a sentence-final number that is not a glued page number', async () => {
    const doc = linedDoc([['Thời hạn: 36', 'Tỷ lệ 3.14']])
    await expect(extractText(doc)).resolves.toBe('Thời hạn: 36\nTỷ lệ 3.14')
  })

  it('repairs a syllable split left by the extractor', async () => {
    const doc = linedDoc([['pháp quyề n xã hộ i chủ nghĩ a']])
    await expect(extractText(doc)).resolves.toBe('pháp quyền xã hội chủ nghĩa')
  })

  it('collapses the doubled spacing a broken-up PDF leaves behind', async () => {
    const doc: PdfDocumentLike = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [textItem('QUỐC  HỘI', 0, 100, 60), textItem('Luật số:', 100, 100, 40)],
        }),
      }),
      destroy: vi.fn(async () => undefined),
    }
    await expect(extractText(doc)).resolves.toBe('QUỐC HỘI Luật số:')
  })

  it('stops and destroys the document on an aborted signal', async () => {
    const doc = fakeDoc(['one', 'two'])
    const controller = new AbortController()
    controller.abort()
    await expect(extractText(doc, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('throws the readable limit error once the running total passes the cap', async () => {
    const doc = fakeDoc(['x'.repeat(MAX_EXTRACTED_CHARS + 1)])
    await expect(extractText(doc)).rejects.toBeInstanceOf(RagExtractionError)
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('extractPdfText', () => {
  beforeEach(() => {
    pdfState.getDocumentCalls = 0
  })

  it('loads a document and returns its text', async () => {
    pdfState.doc = fakeDoc(['hello from the worker'])
    await expect(extractPdfText(new ArrayBuffer(8))).resolves.toBe('hello from the worker')
    expect(pdfState.getDocumentCalls).toBe(1)
  })

  it('throws the limit error for an oversized document', async () => {
    pdfState.doc = fakeDoc(['y'.repeat(MAX_EXTRACTED_CHARS + 1)])
    await expect(extractPdfText(new ArrayBuffer(8))).rejects.toBeInstanceOf(RagExtractionError)
  })
})
