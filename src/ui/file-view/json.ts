export type JsonParse = { ok: true; value: unknown } | { ok: false; message: string }

/** Rendered siblings per level before a "Show more" control appears. */
export const MAX_JSON_CHILDREN = 100

/** Parses a JSON document. An empty document is valid and reads as `null`. */
export function parseJsonDocument(text: string): JsonParse {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The JSON is invalid.' }
  }
}

/** A short type summary for a collapsed node. */
export function jsonValueLabel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  return typeof value
}

/**
 * The bounded window of children to render for an object or array. Only `limit`
 * entries are allocated, so a document with very many siblings cannot stall the
 * main thread before the cap applies. `total` drives the "show more" count.
 */
export function jsonChildren(
  value: unknown,
  limit: number,
): { shown: Array<[string, unknown]>; total: number } {
  if (Array.isArray(value)) {
    const total = value.length
    const count = Math.min(limit, total)
    return {
      shown: Array.from({ length: count }, (_, index) => [String(index), value[index]] as [string, unknown]),
      total,
    }
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>)
    const count = Math.min(limit, keys.length)
    return {
      shown: keys
        .slice(0, count)
        .map((key) => [key, (value as Record<string, unknown>)[key]] as [string, unknown]),
      total: keys.length,
    }
  }
  return { shown: [], total: 0 }
}
