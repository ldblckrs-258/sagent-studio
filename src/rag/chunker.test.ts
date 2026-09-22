import { describe, expect, it } from 'vitest'
import { encode } from 'gpt-tokenizer'
import { chunkText, MAX_CHUNK_TOKENS, MIN_CHUNK_TOKENS } from './chunker'
import type { ChunkDraft } from './types'

function tokensOf(chunk: ChunkDraft): number {
  return encode(chunk.text).length
}

function longText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) =>
    `Paragraph ${i + 1} carries enough words to consume a meaningful number of tokens in the BPE tokenizer.`,
  ).join('\n\n')
}

describe('chunkText', () => {
  it('is deterministic for identical input and parameters', () => {
    const options = { chunkSize: 128, overlap: 24 }
    expect(chunkText(longText(20), options)).toEqual(chunkText(longText(20), options))
  })

  it('returns an empty array for blank input', () => {
    expect(chunkText('   \n\n  \n', { chunkSize: 128, overlap: 0 })).toEqual([])
    expect(chunkText('', { chunkSize: 128, overlap: 0 })).toEqual([])
  })

  it('measures size in tokens and keeps every chunk within the clamp', () => {
    const chunks = chunkText(longText(40), { chunkSize: 128, overlap: 16 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(tokensOf(chunk)).toBeLessThanOrEqual(128)
    }
    expect(Math.max(...chunks.map(tokensOf))).toBeGreaterThan(MIN_CHUNK_TOKENS)
  })

  it('clamps a tiny chunkSize up to the minimum', () => {
    const chunks = chunkText(longText(20), { chunkSize: 5, overlap: 1 })
    for (const chunk of chunks) expect(tokensOf(chunk)).toBeLessThanOrEqual(MIN_CHUNK_TOKENS)
  })

  it('clamps a huge chunkSize down to the maximum', () => {
    const chunks = chunkText(longText(60), { chunkSize: 5000, overlap: 100 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(tokensOf(chunk)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS)
  })

  it('starts the next chunk with the previous chunk tail as overlap', () => {
    const overlap = 16
    const chunks = chunkText(longText(40), { chunkSize: 96, overlap })
    expect(chunks.length).toBeGreaterThan(1)
    const previousTail = encode(chunks[0].text).slice(-overlap)
    const nextHead = encode(chunks[1].text).slice(0, overlap)
    expect(nextHead).toEqual(previousTail)
  })

  it('rejects an overlap that is not smaller than chunkSize', () => {
    expect(() => chunkText('hello world', { chunkSize: 128, overlap: 128 })).toThrow(RangeError)
    expect(() => chunkText('hello world', { chunkSize: 128, overlap: 200 })).toThrow(RangeError)
    expect(() => chunkText('hello world', { chunkSize: 128, overlap: -1 })).toThrow(RangeError)
  })

  it('keeps a markdown heading attached to the block that follows it', () => {
    const text = '# Section One\n\nThe paragraph carries the section body.\n\nA second standalone paragraph.'
    const [first] = chunkText(text, { chunkSize: 256, overlap: 0 })
    expect(first.text.startsWith('# Section One')).toBe(true)
    expect(first.text).toContain('The paragraph carries the section body.')
  })

  it('starts a new block at a legal heading without a blank line', () => {
    const text = [
      'Điều 32. Thẩm quyền của Bộ trưởng.',
      '1. Bộ trưởng trình Thủ tướng.',
      '2. Bộ trưởng phê duyệt đề án.',
      'Điều 33. Hiệu lực thi hành.',
    ].join('\n')
    const chunks = chunkText(text, { chunkSize: 256, overlap: 0 })
    const article32 = chunks.find((chunk) => chunk.text.includes('Điều 32'))
    expect(article32?.text).toContain('Bộ trưởng trình Thủ tướng')
    expect(chunks.some((chunk) => chunk.text.includes('Điều 33'))).toBe(true)
  })

  it('separates a mid-line article heading from the sentence before it', () => {
    const sentence =
      'Nội dung này được viết đủ dài để tạo ra số lượng token cần thiết cho phép thử phân đoạn. '
    let filler = ''
    while (encode(filler).length < 50) filler += sentence
    const text = `Điều 96. ${filler}Điều 97\nNhiệm kỳ của Chính phủ là năm năm.`
    const chunks = chunkText(text, { chunkSize: 64, overlap: 0 })
    const article97 = chunks.find((chunk) => chunk.text.includes('Nhiệm kỳ'))
    expect(article97?.text.trimStart().startsWith('Điều 97')).toBe(true)
  })

  it('does not repeat a consolidated heading line', () => {
    const text = 'Điều 95. Nội dung.\nĐiều 95. Nội dung.\nĐiều 96. Khác.'
    const chunks = chunkText(text, { chunkSize: 256, overlap: 0 })
    const joined = chunks.map((chunk) => chunk.text).join('\n')
    expect(joined.match(/Điều 95/g)?.length).toBe(1)
  })

  it('keeps a reference to an article mid-sentence intact', () => {
    const text = 'Khoản này được quy định tại Điều 97 của Luật này.\nĐiều 98. Hiệu lực.'
    const chunks = chunkText(text, { chunkSize: 256, overlap: 0 })
    const joined = chunks.map((chunk) => chunk.text).join('\n')
    expect(joined).toContain('tại Điều 97')
  })

  it('cuts an oversized block on sentence boundaries, never mid-sentence', () => {
    const sentences = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i + 1} carries enough words to consume tokens.`,
    ).join(' ')
    const chunks = chunkText(sentences, { chunkSize: 64, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.trimEnd().endsWith('.')).toBe(true)
  })

  it('preserves whitespace between sentence and block units when packing', () => {
    const sentences =
      'Alpha bravo charlie delta echo foxtrot golf. Hotel india juliet kilo lima mike november. Oscar papa quebec romeo sierra tango uniform victor.'
    const sentenceChunks = chunkText(sentences, { chunkSize: 64, overlap: 0 })
    const sentenceText = sentenceChunks.map((chunk) => chunk.text).join(' ')
    expect(sentenceText).toMatch(/golf\.\s+Hotel/)
    expect(sentenceText).not.toMatch(/\.[A-Za-z]/)

    const blocks = Array.from(
      { length: 8 },
      (_, i) => `Paragraph ${i} contains a run of ordinary words.`,
    ).join('\n\n')
    const blockChunks = chunkText(blocks, { chunkSize: 64, overlap: 0 })
    expect(blockChunks.map((chunk) => chunk.text).join(' ')).not.toMatch(/\.[A-Za-z]/)
  })

  it('never opens or closes a fallback window mid-word', () => {
    const words = Array.from({ length: 240 }, (_, i) => `word${i}`)
    const chunks = chunkText(words.join(' '), { chunkSize: 48, overlap: 0 })
    const known = new Set(words)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const parts = chunk.text.trim().split(/\s+/)
      expect(known.has(parts[0])).toBe(true)
      expect(known.has(parts[parts.length - 1])).toBe(true)
    }
  })

  it('splits an oversized single paragraph into several chunks', () => {
    const huge = Array.from({ length: 400 }, (_, i) => `token${i}`).join(' ')
    const chunks = chunkText(huge, { chunkSize: 96, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(tokensOf(chunk)).toBeLessThanOrEqual(96)
  })
})
