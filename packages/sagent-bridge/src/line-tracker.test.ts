import { describe, expect, it } from 'vitest'
import { LineTracker, isPlainAnswer } from './line-tracker.js'

describe('LineTracker', () => {
  it('joins input split across writes so rm -r + f cannot slip past per-write checks', () => {
    const tracker = new LineTracker()
    expect(tracker.simulate('rm -r').submitted).toEqual([])
    tracker.apply('rm -r', 'model')
    const { submitted } = tracker.simulate('f ~\r')
    expect(submitted).toEqual([{ line: 'rm -rf ~', opaque: false }])
  })

  it('simulate does not change state, so a denied write leaves the line as it was', () => {
    const tracker = new LineTracker()
    tracker.apply('ls', 'model')
    tracker.simulate(' -la\r')
    expect(tracker.pending).toEqual({ line: 'ls', opaque: false })
  })

  it('marks history keys as opaque, since the shell will run a line the tracker cannot see', () => {
    const tracker = new LineTracker()
    const { submitted } = tracker.simulate('\x1b[A\r')
    expect(submitted).toEqual([{ line: '', opaque: true }])
  })

  it('marks tab completion and ctrl-r search as opaque', () => {
    expect(new LineTracker().simulate('rm -r\t\r').submitted[0].opaque).toBe(true)
    expect(new LineTracker().simulate('\x12rm\r').submitted[0].opaque).toBe(true)
  })

  it('applies backspace and ctrl-u like the shell line editor', () => {
    expect(new LineTracker().simulate('lsx\x7f\r').submitted[0]).toEqual({ line: 'ls', opaque: false })
    expect(new LineTracker().simulate('rm -rf\x15ls\r').submitted[0]).toEqual({ line: 'ls', opaque: false })
  })

  it('keeps a line opaque through ctrl-u once the cursor moved, since ctrl-u then keeps text', () => {
    expect(new LineTracker().simulate('\x10\x10\x01\x15\r').submitted[0].opaque).toBe(true)
    expect(new LineTracker().simulate('rm -rf x\x01\x15\r').submitted[0].opaque).toBe(true)
  })

  it('counts every applied write so a check can be pinned to the state it saw', () => {
    const tracker = new LineTracker()
    expect(tracker.inputVersion).toBe(0)
    tracker.apply('rm -rf x', 'model')
    tracker.apply('y', 'user')
    expect(tracker.inputVersion).toBe(2)
  })

  it('ctrl-c cancels the pending line', () => {
    const tracker = new LineTracker()
    tracker.apply('\x1b[A', 'model')
    expect(tracker.simulate('\x03ls\r').submitted[0]).toEqual({ line: 'ls', opaque: false })
  })

  it('returns every line submitted in one write', () => {
    expect(new LineTracker().simulate('ls\rpwd\r').submitted.map((l) => l.line)).toEqual(['ls', 'pwd'])
  })

  it('treats a partial line typed by the user as opaque to the model', () => {
    const tracker = new LineTracker()
    tracker.apply('rm -rf ', 'user')
    expect(tracker.simulate('~\r').submitted[0].opaque).toBe(true)
  })

  it('resets after the user submits their own line', () => {
    const tracker = new LineTracker()
    tracker.apply('ls\r', 'user')
    expect(tracker.simulate('pwd\r').submitted[0]).toEqual({ line: 'pwd', opaque: false })
  })
})

describe('isPlainAnswer', () => {
  it('accepts only simple answers to a running program', () => {
    for (const line of ['y', 'n', 'YES', 'no', 'q', '', ' y ']) expect(isPlainAnswer({ line, opaque: false })).toBe(true)
    for (const line of [':!rm -rf ~', 'print(1)', 'yy']) expect(isPlainAnswer({ line, opaque: false })).toBe(false)
    expect(isPlainAnswer({ line: 'y', opaque: true })).toBe(false)
  })
})
