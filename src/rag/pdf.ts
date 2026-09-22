import { normalizeVietnameseSyllableSplits, repairMissingSyllableSpaces } from './text-normalize'

/**
 * PDF text extraction through the pdf.js library.
 *
 * The library and its worker are imported dynamically so a user who never adds
 * a PDF never downloads either. The worker runs same-origin: it does not inherit
 * the document meta CSP, has the page's network egress, and can open IndexedDB.
 * The vault key never enters the worker, and decrypted text is never posted to
 * it, so the residual risk is availability and egress rather than key material.
 */
export const MAX_EXTRACTED_CHARS = 1_000_000
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export class RagExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RagExtractionError'
  }
}

interface PdfTextItemLike {
  str?: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>
}

export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy(): Promise<void> | void
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('The PDF extraction was aborted.')
  error.name = 'AbortError'
  return error
}

async function destroyQuietly(pdf: PdfDocumentLike): Promise<void> {
  try {
    await pdf.destroy()
  } catch {
    // Destroying an already-failed document must not mask the real error.
  }
}

/** Loads a PDF document from raw bytes. Dynamic imports keep it out of the entry chunk. */
export async function loadPdf(data: ArrayBuffer | Uint8Array): Promise<PdfDocumentLike> {
  const pdfjs = await import('pdfjs-dist/build/pdf.min.mjs')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data })
  return (await task.promise) as PdfDocumentLike
}

/**
 * A gap wider than this fraction of the glyph height is a word boundary. pdf.js
 * emits one item per text-showing operator, so a PDF that places glyphs or
 * syllables individually produces items with tiny gaps; joining those with a
 * space (or not) is what keeps words intact or splits them apart.
 */
const SPACE_GAP_RATIO = 0.3

const COMBINING_MARK = /\p{M}/u

/**
 * A decomposed (NFD) glyph stream reports each item's width from its base
 * character, so the mark's advance is missing and the computed gap looks wider
 * than it is. Requiring double the word-space threshold at a mark boundary keeps
 * a mid-syllable gap (`cộ` + `ng`) from becoming a space without hard-merging
 * two real words that happen to end on a tone mark (`Bộ` + `trưởng`).
 */
const MARK_GAP_MULTIPLIER = 2

function endsWithCombiningMark(value: string): boolean {
  return COMBINING_MARK.test(value.slice(-1))
}

function startsWithCombiningMark(value: string): boolean {
  return COMBINING_MARK.test(value.slice(0, 1))
}

function itemX(item: PdfTextItemLike): number | null {
  const x = item.transform?.[4]
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

function itemY(item: PdfTextItemLike): number | null {
  const y = item.transform?.[5]
  return typeof y === 'number' && Number.isFinite(y) ? y : null
}

function itemHeight(item: PdfTextItemLike): number {
  if (typeof item.height === 'number' && item.height > 0) return item.height
  const height = item.transform?.[3]
  return typeof height === 'number' && Number.isFinite(height) ? Math.abs(height) : 0
}

/**
 * The page's dominant font height, weighted by how many characters each item
 * contributes so a handful of short items (footnote markers, page numbers) does
 * not move the estimate. Zero when the items carry no geometry.
 */
function bodyFontHeight(items: readonly PdfTextItemLike[]): number {
  const samples: { height: number; weight: number }[] = []
  for (const item of items) {
    const height = itemHeight(item)
    const weight = (item.str ?? '').length
    if (height > 0 && weight > 0) samples.push({ height, weight })
  }
  if (samples.length === 0) return 0
  samples.sort((a, b) => a.height - b.height)
  const half = samples.reduce((sum, sample) => sum + sample.weight, 0) / 2
  let accumulated = 0
  for (const sample of samples) {
    accumulated += sample.weight
    if (accumulated >= half) return sample.height
  }
  return samples[samples.length - 1].height
}

/**
 * Reconstructs one page's text from pdf.js items without inventing spaces.
 * A space is added only when the horizontal gap between two items on the same
 * line exceeds a word-space threshold; a vertical jump or `hasEOL` starts a new
 * line. A gap after a combining mark needs double the word-space threshold
 * before it becomes a space, because a decomposed item underreports its width.
 * When geometry is absent (older callers, tests) it falls back to a single space
 * between items, never splitting off a leading combining mark.
 *
 * A footnote marker is typeset smaller than the body and raised above the
 * baseline; without special handling it fuses onto the number it follows
 * (`Điều 110` + superscript `4` → `Điều 1104`), which corrupts a legal article
 * number. Such an item is treated as its own word so `Điều 110` survives.
 */
export function joinTextItems(items: readonly PdfTextItemLike[]): string {
  const bodyHeight = bodyFontHeight(items)
  let text = ''
  let prevX: number | null = null
  let prevY: number | null = null
  let prevWidth = 0
  let prevHeight = 0
  let spaceAfter = false

  for (const item of items) {
    const str = item.str ?? ''
    if (str.length === 0) continue

    const x = itemX(item)
    const y = itemY(item)
    const height = itemHeight(item)

    const lineJump =
      y !== null && prevY !== null && Math.abs(y - prevY) > 0.5 * Math.max(prevHeight, height, 1)
    const raised = y !== null && prevY !== null && y - prevY > 0.15 * Math.max(prevHeight, height, 1)
    const superscript =
      bodyHeight > 0 && height > 0 && height < bodyHeight * 0.75 && raised && !lineJump

    if (text.length > 0 && !/\s$/.test(text) && !/^\s/.test(str)) {
      if (superscript || spaceAfter) {
        text += ' '
      } else if (x !== null && prevX !== null) {
        if (lineJump) {
          text += '\n'
        } else {
          const gap = x - (prevX + prevWidth)
          const spaceWidth = Math.max(prevHeight, height, 1) * SPACE_GAP_RATIO
          const needed = endsWithCombiningMark(text) ? spaceWidth * MARK_GAP_MULTIPLIER : spaceWidth
          if (!startsWithCombiningMark(str) && gap > needed) text += ' '
        }
      } else if (!startsWithCombiningMark(str)) {
        text += ' '
      }
    }

    text += str
    if (item.hasEOL && !text.endsWith('\n')) text += '\n'

    spaceAfter = superscript
    prevX = x
    prevY = y
    prevWidth = typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : 0
    prevHeight = height
  }

  return text
}

/**
 * Collapses the whitespace pdf.js leaves behind: runs of spaces and unicode
 * spaces become one space, padding around line breaks is trimmed, and blank
 * lines are capped at one. NFC composes detached diacritics back onto their base
 * character. This keeps broken-up PDF text from inflating the token count sent
 * to an embedding provider.
 */
function normalizeWhitespace(text: string): string {
  const collapsed = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Missing spaces first, then injected splits: the split repair never merges
  // the two valid syllables it produces, so the order is not symmetric.
  return normalizeVietnameseSyllableSplits(repairMissingSyllableSpaces(collapsed))
}

/**
 * A page whose text layer was produced from a font without a ToUnicode CMap
 * extracts as glyph codes, not characters: brackets and quotes fused into words,
 * rare symbols, and letters glued to digits. Such a page is unreadable and
 * un-citable, so it must be dropped before it enters the index rather than
 * returned to the model as a passage. The signal is per token and the page is
 * only dropped when the suspicious share clears the threshold, which keeps a
 * clean page that happens to contain a stray glyph.
 */
const GARBLE_MIN_TOKENS = 20
const GARBLE_RATIO = 0.2

const ALLOWED_CHARS = /[\p{L}\p{N}\s.,:/%\-–—…!?;'"()[\]{}]/u
const INTERNAL_GLUE = /[\p{L}\p{N}][()[\]{}"'*+=<>@#|\\~^][\p{L}\p{N}]/u
const LETTER_DIGIT = /\p{L}\d|\d\p{L}/u

function isSuspiciousToken(token: string): boolean {
  if (LETTER_DIGIT.test(token) || INTERNAL_GLUE.test(token)) return true
  for (const char of token) if (!ALLOWED_CHARS.test(char)) return true
  return false
}

function isGarbledPage(text: string): boolean {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length < GARBLE_MIN_TOKENS) return false
  let suspicious = 0
  for (const token of tokens) if (isSuspiciousToken(token)) suspicious += 1
  return suspicious / tokens.length >= GARBLE_RATIO
}

const TRAILING_PAGE_NUMBER = /([;)\]”"’'])\d{1,4}(?=\n|$)/g
const BARE_PAGE_NUMBER = /^\s*\d{1,4}\s*$/

function furnitureKey(line: string): string {
  return line.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Lines that repeat across most pages are page furniture (running headers,
 * footers, a stamped status), not prose. Every occurrence is removed.
 */
function repeatedFurniture(pages: readonly string[]): Set<string> {
  if (pages.length < 2) return new Set()
  const threshold = Math.ceil(pages.length / 2)
  const counts = new Map<string, number>()
  for (const page of pages) {
    const seen = new Set<string>()
    for (const line of page.split('\n')) {
      const key = furnitureKey(line)
      if (key.length === 0 || key.length > 120 || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const furniture = new Set<string>()
  for (const [key, count] of counts) if (count >= 2 && count >= threshold) furniture.add(key)
  return furniture
}

/**
 * Removes page furniture and page numbers from each page before the pages are
 * joined. A page number glued to the end of a line survives extraction as
 * `…tháng.”;7`, so a closing bracket or quote immediately followed by 1-4 digits
 * at line end is stripped. The pattern deliberately excludes `.` and `:` so a
 * sentence-final number (`Thời hạn: 36`) or a decimal is not eaten.
 */
function stripPageFurniture(pages: readonly string[]): string {
  const furniture = repeatedFurniture(pages)
  const cleaned: string[] = []
  for (const page of pages) {
    const lines = page.split('\n').filter((line) => {
      const key = furnitureKey(line)
      return key.length === 0 || !furniture.has(key)
    })
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length > 1 && BARE_PAGE_NUMBER.test(lines[0])) lines.shift()
    if (lines.length > 1 && BARE_PAGE_NUMBER.test(lines[lines.length - 1])) lines.pop()
    const text = lines
      .join('\n')
      .replace(TRAILING_PAGE_NUMBER, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text.length > 0) cleaned.push(text)
  }
  return cleaned.join('\n\n')
}

/**
 * Walks a document page by page and joins each page's text in page order. Stops
 * on an aborted signal and destroys the document on that path. Throws the
 * readable limit error as soon as the running total passes `MAX_EXTRACTED_CHARS`,
 * so an oversized PDF is stopped during extraction rather than after it.
 */
export async function extractText(
  pdf: PdfDocumentLike,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = []
  let total = 0
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    if (signal?.aborted) {
      await destroyQuietly(pdf)
      throw abortError(signal.reason)
    }
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = normalizeWhitespace(joinTextItems(content.items))
    // A garbled page is dropped here, before the readable-limit total, so a
    // font-without-ToUnicode page never becomes a passage or an embedding.
    if (text.length === 0 || isGarbledPage(text)) continue
    total += text.length
    if (total > MAX_EXTRACTED_CHARS) {
      await destroyQuietly(pdf)
      throw new RagExtractionError(
        `This PDF extracts more than the ${MAX_EXTRACTED_CHARS.toLocaleString()} character limit.`,
      )
    }
    parts.push(text)
  }
  return stripPageFurniture(parts)
}

/** Composes load and extract; the enforcement point for a PDF ingest. */
export async function extractPdfText(
  data: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const pdf = await loadPdf(data)
  try {
    return await extractText(pdf, signal)
  } finally {
    // Release the parsed document and its worker-side structures on success too.
    await destroyQuietly(pdf)
  }
}
