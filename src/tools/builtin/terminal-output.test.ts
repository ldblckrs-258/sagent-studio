import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampInt, truncateMiddle, waitForQuiet } from './terminal-output'

afterEach(() => {
  vi.useRealTimers()
})

describe('truncateMiddle', () => {
  it('leaves short output alone', () => {
    expect(truncateMiddle('hello', 10)).toEqual({ text: 'hello', truncated: false })
  })

  it('keeps the start and the end, where commands print their banner and their result', () => {
    const text = `${'a'.repeat(50)}${'b'.repeat(50)}`
    const { text: out, truncated } = truncateMiddle(text, 20)
    expect(truncated).toBe(true)
    expect(out.startsWith('a'.repeat(8))).toBe(true)
    expect(out.endsWith('b'.repeat(12))).toBe(true)
    expect(out).toContain('…[80 chars omitted]…')
  })

  it('never splits a surrogate pair at either cut', () => {
    const text = '😀'.repeat(40)
    const { text: out } = truncateMiddle(text, 21)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe('waitForQuiet', () => {
  function source() {
    let listener: () => void = () => {}
    let done = false
    return {
      watch: (fn: () => void) => {
        listener = fn
        return () => {
          listener = () => {}
        }
      },
      emit: () => listener(),
      finish: () => {
        done = true
        listener()
      },
      isDone: () => done,
    }
  }

  it('returns once output stops for the idle window', async () => {
    vi.useFakeTimers()
    const s = source()
    const wait = waitForQuiet({ watch: s.watch, isDone: s.isDone, waitMs: 5000 })
    vi.advanceTimersByTime(300)
    s.emit()
    vi.advanceTimersByTime(300)
    s.emit()
    vi.advanceTimersByTime(400)
    await expect(wait).resolves.toBe('idle')
  })

  it('stops at the deadline even while output keeps streaming', async () => {
    vi.useFakeTimers()
    const s = source()
    const wait = waitForQuiet({ watch: s.watch, isDone: s.isDone, waitMs: 1000 })
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100)
      s.emit()
    }
    await expect(wait).resolves.toBe('deadline')
  })

  it('returns as soon as the process exits', async () => {
    vi.useFakeTimers()
    const s = source()
    const wait = waitForQuiet({ watch: s.watch, isDone: s.isDone, waitMs: 5000 })
    s.finish()
    await expect(wait).resolves.toBe('exit')
  })

  it('returns when aborted', async () => {
    const s = source()
    const controller = new AbortController()
    const wait = waitForQuiet({ watch: s.watch, isDone: s.isDone, waitMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(wait).resolves.toBe('aborted')
  })
})

it('clampInt bounds model-supplied numbers', () => {
  expect(clampInt(undefined, 800, 0, 30000)).toBe(800)
  expect(clampInt(99999, 800, 0, 30000)).toBe(30000)
  expect(clampInt(-5, 800, 0, 30000)).toBe(0)
  expect(clampInt('10', 800, 0, 30000)).toBe(800)
})
