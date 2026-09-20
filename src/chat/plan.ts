import { ChatConfigError } from './errors'
import { MAX_PLAN_ITEMS, MAX_PLAN_TEXT_LENGTH } from './types'
import type { PlanItem, PlanItemStatus } from './types'

const PLAN_STATUSES: readonly PlanItemStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type PlanParse = { ok: true; items: PlanItem[] } | { ok: false; message: string }

export function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasForbiddenKey(value: Record<string, unknown>): string | null {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key
  }
  return null
}

/** Strict parse: every item must already carry a valid id, text, and status. */
export function parsePlanItems(value: unknown): PlanParse {
  if (!Array.isArray(value)) return { ok: false, message: 'plan must be an array' }
  if (value.length > MAX_PLAN_ITEMS) {
    return { ok: false, message: `plan has more than ${MAX_PLAN_ITEMS} items` }
  }
  const items: PlanItem[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return { ok: false, message: 'every plan item must be an object' }
    const forbidden = hasForbiddenKey(entry)
    if (forbidden !== null) {
      return { ok: false, message: `plan item has an unsafe key "${forbidden}"` }
    }
    const id = entry.id
    const text = entry.text
    const status = entry.status
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      return { ok: false, message: 'every plan item needs an id of at most 64 characters' }
    }
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PLAN_TEXT_LENGTH) {
      return {
        ok: false,
        message: `every plan item needs text of at most ${MAX_PLAN_TEXT_LENGTH} characters`,
      }
    }
    if (!isPlanItemStatus(status)) {
      return { ok: false, message: 'every plan item needs a valid status' }
    }
    items.push({ id, text, status })
  }
  return { ok: true, items }
}

/** Tolerant parse for `validateThread`; a missing plan reads as undefined. */
export function validatePlanItems(value: unknown): PlanItem[] | undefined {
  if (value === undefined) return undefined
  const parsed = parsePlanItems(value)
  if (!parsed.ok) throw new ChatConfigError(`plan is invalid: ${parsed.message}.`)
  return parsed.items
}

/** Tool-input parse: derives missing ids and defaults the status to pending. */
export function normalizePlanItems(value: unknown): PlanParse {
  if (!Array.isArray(value)) return { ok: false, message: 'items must be an array' }
  if (value.length > MAX_PLAN_ITEMS) {
    return { ok: false, message: `items has more than ${MAX_PLAN_ITEMS} entries` }
  }
  const items: PlanItem[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isPlainObject(entry)) {
      return { ok: false, message: 'every plan item must be an object' }
    }
    const forbidden = hasForbiddenKey(entry)
    if (forbidden !== null) {
      return { ok: false, message: `plan item has an unsafe key "${forbidden}"` }
    }
    const rawText = entry.text
    if (typeof rawText !== 'string') {
      return { ok: false, message: 'every plan item needs text' }
    }
    const text = rawText.trim()
    if (text.length === 0 || text.length > MAX_PLAN_TEXT_LENGTH) {
      return {
        ok: false,
        message: `every plan item needs text of at most ${MAX_PLAN_TEXT_LENGTH} characters`,
      }
    }
    const rawId = entry.id
    const id =
      typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 64
        ? rawId
        : `p${index + 1}`
    const rawStatus = entry.status ?? 'pending'
    if (!isPlanItemStatus(rawStatus)) {
      return { ok: false, message: 'every plan item needs a valid status' }
    }
    items.push({ id, text, status: rawStatus })
  }
  return { ok: true, items }
}
export function planCounts(items: readonly PlanItem[]): Record<PlanItemStatus, number> {
  const counts: Record<PlanItemStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  }
  for (const item of items) counts[item.status] += 1
  return counts
}

export interface PlanTextChange {
  id: string
  from: string
  to: string
}

/**
 * Plan ids are the stable handle for an item; reusing an id with new text
 * silently rewrites the item's meaning and breaks cross-turn comparison. This
 * reports those retextings so the tool can warn the model.
 */
export function planTextChanges(
  previous: readonly PlanItem[],
  next: readonly PlanItem[],
): PlanTextChange[] {
  if (previous.length === 0) return []
  const before = new Map(previous.map((item) => [item.id, item.text]))
  const changes: PlanTextChange[] = []
  for (const item of next) {
    const from = before.get(item.id)
    if (from !== undefined && from !== item.text) changes.push({ id: item.id, from, to: item.text })
  }
  return changes
}
