import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring-buffer.js'

describe('RingBuffer', () => {
  it('keeps absolute byte offsets across wraparound so a reconnecting client can resume', () => {
    const ring = new RingBuffer(8)
    expect(ring.append(Buffer.from('abcdef'))).toBe(0)
    expect(ring.append(Buffer.from('ghij'))).toBe(6)
    expect(ring.startOffset).toBe(2)
    const slice = ring.read(6, 100)
    expect(slice.bytes.toString()).toBe('ghij')
    expect(slice).toMatchObject({ fromOffset: 6, nextOffset: 10, truncated: false })
  })

  it('reports truncated when the requested offset was already overwritten', () => {
    const ring = new RingBuffer(8)
    ring.append(Buffer.from('0123456789'))
    const slice = ring.read(0, 100)
    expect(slice.truncated).toBe(true)
    expect(slice.fromOffset).toBe(2)
    expect(slice.bytes.toString()).toBe('23456789')
  })

  it('returns the tail when no offset is given, flagging that older output exists', () => {
    const ring = new RingBuffer(64)
    ring.append(Buffer.from('line1\nline2\n'))
    const slice = ring.read(undefined, 6)
    expect(slice.bytes.toString()).toBe('line2\n')
    expect(slice.truncated).toBe(true)
    expect(ring.read(undefined, 100).truncated).toBe(false)
  })

  it('never starts a window in the middle of a UTF-8 character', () => {
    const ring = new RingBuffer(64)
    ring.append(Buffer.from('a€b'))
    const slice = ring.read(2, 100)
    expect(slice.fromOffset).toBe(4)
    expect(slice.bytes.toString()).toBe('b')
  })

  it('never ends a window in the middle of a UTF-8 character', () => {
    const ring = new RingBuffer(64)
    ring.append(Buffer.from('a€b'))
    const slice = ring.read(0, 3)
    expect(slice.bytes.toString()).toBe('a')
    expect(slice.nextOffset).toBe(1)
  })

  it('holds back a partial character at the live edge until the rest arrives', () => {
    const ring = new RingBuffer(64)
    const euro = Buffer.from('€')
    ring.append(Buffer.concat([Buffer.from('x'), euro.subarray(0, 2)]))
    expect(ring.read(0, 100).bytes.toString()).toBe('x')
    ring.append(euro.subarray(2))
    expect(ring.read(1, 100).bytes.toString()).toBe('€')
  })

  it('handles a chunk larger than the capacity', () => {
    const ring = new RingBuffer(4)
    ring.append(Buffer.from('abcdefgh'))
    expect(ring.read(undefined, 100).bytes.toString()).toBe('efgh')
    expect(ring.endOffset).toBe(8)
  })
})
