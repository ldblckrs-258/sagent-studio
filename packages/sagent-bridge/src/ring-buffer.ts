export const DEFAULT_RING_BYTES = 1024 * 1024

export interface RingSlice {
  bytes: Buffer
  fromOffset: number
  nextOffset: number
  truncated: boolean
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 1
}

export class RingBuffer {
  private readonly buffer: Buffer
  private end = 0

  constructor(readonly capacity: number = DEFAULT_RING_BYTES) {
    this.buffer = Buffer.alloc(capacity)
  }

  get startOffset(): number {
    return Math.max(0, this.end - this.capacity)
  }

  get endOffset(): number {
    return this.end
  }

  append(chunk: Buffer): number {
    const offset = this.end
    const data = chunk.length > this.capacity ? chunk.subarray(chunk.length - this.capacity) : chunk
    const skipped = chunk.length - data.length
    let position = (this.end + skipped) % this.capacity
    let written = 0
    while (written < data.length) {
      const count = Math.min(data.length - written, this.capacity - position)
      data.copy(this.buffer, position, written, written + count)
      written += count
      position = (position + count) % this.capacity
    }
    this.end += chunk.length
    return offset
  }

  private byteAt(offset: number): number {
    return this.buffer[offset % this.capacity]
  }

  private copy(from: number, to: number): Buffer {
    const out = Buffer.alloc(to - from)
    let written = 0
    let offset = from
    while (offset < to) {
      const position = offset % this.capacity
      const count = Math.min(to - offset, this.capacity - position)
      this.buffer.copy(out, written, position, position + count)
      written += count
      offset += count
    }
    return out
  }

  read(sinceOffset: number | undefined, maxBytes: number): RingSlice {
    const start = this.startOffset
    let from: number
    let truncated: boolean
    if (sinceOffset === undefined) {
      from = Math.max(start, this.end - maxBytes)
      truncated = from > start
    } else {
      from = Math.min(Math.max(sinceOffset, start), this.end)
      truncated = sinceOffset < start
    }
    let to = Math.min(this.end, from + maxBytes)
    let guard = 0
    while (from < to && guard < 3 && isContinuation(this.byteAt(from))) {
      from++
      guard++
    }
    for (let back = 1; back <= 4 && to - back >= from; back++) {
      const byte = this.byteAt(to - back)
      if (isContinuation(byte)) continue
      if (to - back + sequenceLength(byte) > to) to -= back
      break
    }
    return { bytes: this.copy(from, to), fromOffset: from, nextOffset: to, truncated }
  }
}
