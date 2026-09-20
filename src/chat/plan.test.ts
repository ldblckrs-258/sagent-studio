import { describe, expect, it } from 'vitest'
import { normalizePlanItems, parsePlanItems, planCounts, planTextChanges, validatePlanItems } from './plan'
import { MAX_PLAN_ITEMS, MAX_PLAN_TEXT_LENGTH } from './types'
import type { PlanItem } from './types'

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return { id: 'p1', text: 'Do the thing', status: 'pending', ...overrides }
}

describe('validatePlanItems', () => {
  it('round-trips a valid list and reads a missing plan as undefined', () => {
    const items = [item(), item({ id: 'p2', status: 'completed' })]
    expect(validatePlanItems(items)).toEqual(items)
    expect(validatePlanItems(undefined)).toBeUndefined()
  })

  it('rejects an over-long list, over-long text, empty fields, and unknown status', () => {
    expect(() => validatePlanItems(Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => item({ id: `p${i}` })))).toThrow(/plan/)
    expect(() => validatePlanItems([item({ text: 'x'.repeat(MAX_PLAN_TEXT_LENGTH + 1) })])).toThrow(/plan/)
    expect(() => validatePlanItems([item({ id: '' })])).toThrow(/plan/)
    expect(() => validatePlanItems([item({ text: '' })])).toThrow(/plan/)
    expect(() => validatePlanItems([item({ status: 'nope' as never })])).toThrow(/plan/)
  })

  it('rejects a forbidden key', () => {
    const evil = JSON.parse('{"__proto__":{"x":1},"id":"p1","text":"t","status":"pending"}') as PlanItem
    expect(() => validatePlanItems([evil])).toThrow(/plan/)
  })
})

describe('normalizePlanItems', () => {
  it('derives ids deterministically and defaults the status', () => {
    expect(normalizePlanItems([{ text: 'one' }, { text: 'two', status: 'completed' }])).toEqual({
      ok: true,
      items: [
        { id: 'p1', text: 'one', status: 'pending' },
        { id: 'p2', text: 'two', status: 'completed' },
      ],
    })
  })

  it('rejects a non-array, a bad item, an over-long list, and an unknown status', () => {
    expect(normalizePlanItems(undefined)).toMatchObject({ ok: false })
    expect(normalizePlanItems([42])).toMatchObject({ ok: false })
    expect(normalizePlanItems(Array.from({ length: MAX_PLAN_ITEMS + 1 }, () => ({ text: 'x' })))).toMatchObject({
      ok: false,
    })
    expect(normalizePlanItems([{ text: 'x', status: 'nope' }])).toMatchObject({ ok: false })
    expect(normalizePlanItems([{ text: '   ' }])).toMatchObject({ ok: false })
  })
})

describe('parsePlanItems', () => {
  it('reports a failure object instead of throwing', () => {
    expect(parsePlanItems('nope')).toEqual({ ok: false, message: 'plan must be an array' })
  })
})

describe('planCounts', () => {
  it('counts every status, including zeros', () => {
    expect(
      planCounts([
        item({ status: 'pending' }),
        item({ status: 'pending' }),
        item({ status: 'completed' }),
      ]),
    ).toEqual({ pending: 2, in_progress: 0, completed: 1, cancelled: 0 })
  })
})

describe('planTextChanges', () => {
  it('reports an id whose text changed and ignores stable ids', () => {
    const previous: PlanItem[] = [
      { id: '1', text: 'Build the parser', status: 'pending' },
      { id: '2', text: 'Wire the UI', status: 'pending' },
    ]
    const next: PlanItem[] = [
      { id: '1', text: 'Rework the parser', status: 'pending' },
      { id: '2', text: 'Wire the UI', status: 'completed' },
      { id: '3', text: 'Ship it', status: 'pending' },
    ]
    expect(planTextChanges(previous, next)).toEqual([
      { id: '1', from: 'Build the parser', to: 'Rework the parser' },
    ])
  })

  it('returns nothing for an empty previous plan', () => {
    expect(planTextChanges([], [{ id: '1', text: 'x', status: 'pending' }])).toEqual([])
  })
})
