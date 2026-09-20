import { describe, expect, it } from 'vitest'
import { MAX_JSON_CHILDREN, jsonChildren, jsonValueLabel, parseJsonDocument } from './json'

describe('parseJsonDocument', () => {
  it('parses an object and an array', () => {
    expect(parseJsonDocument('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonDocument('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] })
  })

  it('parses a scalar', () => {
    expect(parseJsonDocument('42')).toEqual({ ok: true, value: 42 })
  })

  it('treats an empty document as null', () => {
    expect(parseJsonDocument('   ')).toEqual({ ok: true, value: null })
  })

  it('reports a message for invalid input', () => {
    const result = parseJsonDocument('{nope}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
  })
})

describe('jsonValueLabel', () => {
  it('summarizes each type', () => {
    expect(jsonValueLabel({ a: 1 })).toBe('object')
    expect(jsonValueLabel([1, 2, 3])).toBe('array(3)')
    expect(jsonValueLabel('x')).toBe('string')
    expect(jsonValueLabel(1)).toBe('number')
    expect(jsonValueLabel(true)).toBe('boolean')
    expect(jsonValueLabel(null)).toBe('null')
  })
})

describe('MAX_JSON_CHILDREN', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(MAX_JSON_CHILDREN)).toBe(true)
    expect(MAX_JSON_CHILDREN).toBeGreaterThan(0)
  })
})

describe('jsonChildren', () => {
  it('bounds allocation and reports the total for a wide array', () => {
    const wide = Array.from({ length: 200_000 }, (_, index) => index)
    const { shown, total } = jsonChildren(wide, MAX_JSON_CHILDREN)
    expect(shown).toHaveLength(MAX_JSON_CHILDREN)
    expect(shown[0]).toEqual(['0', 0])
    expect(total).toBe(200_000)
  })

  it('returns the object entries in the window and the full total', () => {
    expect(jsonChildren({ a: 1, b: 2 }, 10)).toEqual({
      shown: [
        ['a', 1],
        ['b', 2],
      ],
      total: 2,
    })
    expect(jsonChildren([1, 2, 3], 2)).toEqual({
      shown: [
        ['0', 1],
        ['1', 2],
      ],
      total: 3,
    })
  })

  it('returns an empty window for a scalar', () => {
    expect(jsonChildren(5, 10)).toEqual({ shown: [], total: 0 })
    expect(jsonChildren(null, 10)).toEqual({ shown: [], total: 0 })
  })
})
