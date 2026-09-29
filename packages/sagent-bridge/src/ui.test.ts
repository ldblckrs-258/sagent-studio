import { describe, expect, it } from 'vitest'
import { box, painter, supportsColor, tildify, visibleWidth } from './ui.js'

describe('supportsColor', () => {
  it('colors a terminal but not a pipe, so logs and test captures stay plain', () => {
    expect(supportsColor({ isTTY: true }, {})).toBe(true)
    expect(supportsColor({ isTTY: false }, {})).toBe(false)
    expect(supportsColor({}, {})).toBe(false)
  })

  it('honors NO_COLOR, FORCE_COLOR and dumb terminals', () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true)
    expect(supportsColor({ isTTY: true }, { FORCE_COLOR: '0', TERM: 'dumb' })).toBe(false)
    expect(supportsColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
  })
})

describe('painter', () => {
  it('leaves text untouched when color is off', () => {
    expect(painter(false)('red', 'boom')).toBe('boom')
  })

  it('wraps text in codes that do not change its visible width', () => {
    const painted = painter(true)('bold', 'hi')
    expect(painted).not.toBe('hi')
    expect(visibleWidth(painted)).toBe(2)
  })
})

describe('tildify', () => {
  it('shortens paths under home but never a sibling that only shares the prefix', () => {
    expect(tildify('/Users/me/code/app', '/Users/me')).toBe('~/code/app')
    expect(tildify('/Users/me', '/Users/me')).toBe('~')
    expect(tildify('/Users/meta/app', '/Users/me')).toBe('/Users/meta/app')
    expect(tildify('/srv/app', '/')).toBe('/srv/app')
  })
})

describe('box', () => {
  it('lines up the right border even when rows carry color codes', () => {
    const paint = painter(true)
    const rows = box([paint('cyan', 'ws://127.0.0.1:7717'), 'root /a'], paint)
      .trimEnd()
      .split('\n')
    const widths = rows.map(visibleWidth)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe('ws://127.0.0.1:7717'.length + 6)
  })

  it('drops the frame when the terminal is too narrow, so long paths never wrap into a broken box', () => {
    const text = box(['/a/very/long/project/path'], painter(false), 20)
    expect(text).toBe('  /a/very/long/project/path\n')
  })
})
