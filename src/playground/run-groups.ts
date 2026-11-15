import type { RunMeta } from './store'

export interface RunGroup {
  key: string
  runs: RunMeta[]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
  return Object.fromEntries(entries)
}

export function settingsKey(run: RunMeta): string {
  return JSON.stringify([
    run.providerId,
    run.model,
    canonical(run.ref ?? null),
    canonical(run.input),
    [...run.secretFields].sort(),
    run.inputImages.map((image) => [image.field, image.name, image.mime, image.size]),
  ])
}

export function groupRuns(runs: readonly RunMeta[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const run of runs) {
    const key = settingsKey(run)
    const group = groups.get(key)
    if (group) group.runs.push(run)
    else groups.set(key, { key, runs: [run] })
  }
  return [...groups.values()]
}
