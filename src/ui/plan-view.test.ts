import { describe, expect, it } from 'vitest'
import { planPreview, planSummary } from './plan-view'
import type { PlanItem, PlanItemStatus } from '../chat/types'

function step(id: string, status: PlanItemStatus): PlanItem {
  return { id, text: id, status }
}

describe('planPreview', () => {
  it('reads an empty plan as nothing to report', () => {
    expect(planPreview([])).toBeNull()
  })

  it('reports the first step in flight as now', () => {
    const items = [step('a', 'completed'), step('b', 'in_progress'), step('c', 'pending')]
    expect(planPreview(items)).toEqual({ kind: 'now', item: items[1] })
  })

  it('falls back to the earliest pending step as next', () => {
    const items = [step('a', 'completed'), step('b', 'pending'), step('c', 'pending')]
    expect(planPreview(items)).toEqual({ kind: 'next', item: items[1] })
  })

  it('never claims completion when a step was cancelled', () => {
    expect(planPreview([step('a', 'completed'), step('b', 'cancelled')])).toEqual({
      kind: 'halted',
    })
    expect(planPreview([step('a', 'completed'), step('b', 'completed')])).toEqual({ kind: 'done' })
  })
})

describe('planSummary', () => {
  it('counts every status and keeps open as the pending plus in-progress total', () => {
    const items = [
      step('a', 'pending'),
      step('b', 'pending'),
      step('c', 'in_progress'),
      step('d', 'completed'),
      step('e', 'cancelled'),
    ]
    expect(planSummary(items)).toEqual({
      total: 5,
      pending: 2,
      inProgress: 1,
      completed: 1,
      cancelled: 1,
      open: 3,
    })
  })

  it('reads an empty plan as all zeros', () => {
    expect(planSummary([])).toEqual({
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
      open: 0,
    })
  })
})
