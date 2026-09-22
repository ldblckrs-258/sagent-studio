import { decode, encode } from 'gpt-tokenizer'
import type { ChunkDraft } from './types'

/**
 * Chunk sizes are token counts, not characters. The tokenizer is a pure
 * TypeScript BPE (no wasm), so it runs on the main thread under the production
 * CSP. The lower clamp keeps a chunk long enough to carry evidence; the upper
 * clamp keeps one passage plus its Jev questions inside the 32k-token state
 * budget and leaves headroom under the embedding model's input limit.
 */
export const MIN_CHUNK_TOKENS = 64
export const MAX_CHUNK_TOKENS = 1024

export interface ChunkOptions {
  chunkSize: number
  overlap: number
}

/** A structural block and the section heading that governs it, if any. */
interface Block {
  /** The block text; the first block under a heading begins with that heading. */
  body: string
}

/** A block with its tokenization, produced before chunks are packed. */
interface Unit {
  tokens: number[]
}

export function clampChunkSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_CHUNK_TOKENS
  return Math.min(MAX_CHUNK_TOKENS, Math.max(MIN_CHUNK_TOKENS, Math.trunc(value)))
}

/** Clamps and validates the raw parameters; the effective values are what get persisted. */
export function resolveChunkParams(options: ChunkOptions): ChunkOptions {
  const chunkSize = clampChunkSize(options.chunkSize)
  const overlap = Number.isFinite(options.overlap) ? Math.trunc(options.overlap) : 0
  if (overlap < 0 || overlap >= chunkSize) {
    throw new RangeError(`overlap must be >= 0 and < chunkSize (${chunkSize}); got ${overlap}.`)
  }
  return { chunkSize, overlap }
}

const MARKDOWN_HEADING = /^#{1,6}\s/

/**
 * Vietnamese legal structure, plus its unaccented form. PDF extraction rarely
 * leaves blank lines, so a page arrives as one block and the only boundaries the
 * old chunker recognized were markdown `#` and page breaks — every article on
 * the page fused into one passage. Recognizing these markers line by line is
 * what keeps an `Điều` intact and attaches its header to the chunk.
 */
const LEGAL_HEADING = /^\s*(Điều|Dieu|Chương|Chuong|Phần|Phan|Mục|Muc)\b/iu

/**
 * A legal heading that follows a sentence on the same line. PDF extraction
 * rarely leaves the heading at a line start: a page arrives as
 * `…của mình. Điều 97` and the line-anchored `LEGAL_HEADING` never fires, so the
 * article fuses with the previous one. Inserting a break before such a heading
 * lets the normal block splitter see it. A mid-sentence reference (`tại Điều 97`)
 * is preceded by a word, not sentence punctuation, so it is left intact.
 */
const MID_LINE_HEADING =
  /([.!?;:…]["”’»)\]]?)[ \t]+(?=(?:Điều|Dieu|Chương|Chuong|Phần|Phan|Mục|Muc)\s+\d)/giu

function isHeading(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 120) return false
  return MARKDOWN_HEADING.test(trimmed) || LEGAL_HEADING.test(trimmed)
}

/**
 * Splits text into structural blocks on headings and blank lines. A heading
 * governs every block until the next heading, and the first block under it
 * begins with the heading so a passage always carries its section title. A
 * consolidated document repeats a heading (the same `Điều 95` twice); the repeat
 * is skipped rather than starting an empty section.
 */
function splitBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(MID_LINE_HEADING, '$1\n')
  const blocks: Block[] = []
  let current: string[] = []
  let section: string | null = null
  let lastEmitted: string | null = null

  const flush = (): void => {
    const body = current.join('\n').trim()
    if (body !== '') {
      blocks.push({ body })
      lastEmitted = section
    }
    current = []
  }

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') {
      if (current.length > 0) flush()
      continue
    }
    if (isHeading(line)) {
      const heading = line.trim()
      if (heading === section && current.length === 0) continue
      if (current.length > 0) {
        flush()
      } else if (section !== null && lastEmitted !== section) {
        // The previous heading carried its whole content on the heading line
        // (common for a one-line article), so emit it before it is replaced.
        blocks.push({ body: section })
        lastEmitted = section
      }
      section = heading
      continue
    }
    if (current.length === 0 && section !== null) current.push(section)
    current.push(line)
  }
  flush()
  // A heading with no body (the document ends on it) is still a block, so the
  // section is represented rather than silently dropped.
  if (section !== null && lastEmitted !== section) {
    blocks.push({ body: section })
  }
  return blocks
}

/**
 * Sentence and clause boundaries, then line breaks. Splitting an oversized block
 * here before any fixed window keeps the window from opening mid-sentence or
 * stitching a word fragment onto the next chunk through the overlap prefix.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:…)\]”"’'])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function windowTokens(tokens: number[], size: number): number[][] {
  const windows: number[][] = []
  for (let start = 0; start < tokens.length; start += size) {
    windows.push(tokens.slice(start, start + size))
  }
  return windows
}

/**
 * Packs a text span into token groups no larger than `size`, breaking only at
 * whitespace. A raw token window can open mid-word, and the overlap prefix then
 * stitches a fragment onto the next chunk; packing whole words avoids both. A
 * single word longer than `size` (no whitespace to break at) falls back to a
 * token window.
 */
function packByWords(text: string, size: number): number[][] {
  const pieces = text.match(/\s+|\S+/gu) ?? []
  const groups: number[][] = []
  let current: number[] = []
  for (const piece of pieces) {
    const tokens = encode(piece)
    if (tokens.length > size) {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
      for (const window of windowTokens(tokens, size)) groups.push(window)
      continue
    }
    if (current.length + tokens.length > size) {
      groups.push(current)
      current = []
    }
    current.push(...tokens)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Expands blocks into token-window units no larger than `size`. A block that fits
 * is one unit; an oversized block is split on sentence boundaries first, then
 * packed by whole words.
 *
 * Tokenizer encodes the whitespace between two pieces into the second piece's
 * leading token, so joining decoded pieces requires a separating space: the
 * separator is restored on every unit that does not continue the previous one
 * (a new sentence, a new block). Pieces within one pack are continuations of
 * their span and must not be re-separated.
 */
function toUnits(blocks: Block[], size: number): Unit[] {
  const units: Unit[] = []
  for (const block of blocks) {
    const lead = units.length === 0 ? '' : ' '
    const tokens = encode(`${lead}${block.body}`)
    if (tokens.length <= size) {
      units.push({ tokens })
      continue
    }
    let first = true
    for (const sentence of splitSentences(block.body)) {
      const segment = first ? `${lead}${sentence}` : ` ${sentence}`
      for (const group of packByWords(segment, size)) units.push({ tokens: group })
      first = false
    }
  }
  return units
}

/**
 * Deterministic token-based chunking. Identical input and parameters yield
 * identical chunks. Each chunk carries the trailing `overlap` tokens of the
 * previous chunk as a prefix, and no chunk exceeds the clamped `chunkSize`.
 */
export function chunkText(text: string, options: ChunkOptions): ChunkDraft[] {
  const { chunkSize, overlap } = resolveChunkParams(options)

  const blocks = splitBlocks(text)
  if (blocks.length === 0) return []

  const units = toUnits(blocks, chunkSize)
  const chunkTokens: number[][] = []
  let current: number[] = []

  for (const unit of units) {
    if (current.length > 0 && current.length + unit.tokens.length > chunkSize) {
      chunkTokens.push(current)
      // Start the next chunk with the previous chunk's tail. Trim that prefix
      // when the incoming unit leaves no room, so the budget still holds.
      const headroom = Math.max(0, chunkSize - unit.tokens.length)
      const tail = overlap > 0 ? current.slice(-overlap) : []
      current = tail.slice(0, headroom)
    }
    current.push(...unit.tokens)
  }
  if (current.length > 0) chunkTokens.push(current)

  return chunkTokens.map((tokens, ordinal) => ({ ordinal, text: decode(tokens) }))
}
