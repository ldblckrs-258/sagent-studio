let key: CryptoKey | null = null
let generation = 0

export function install(next: CryptoKey): void {
  key = next
  generation += 1
}

export function clear(): void {
  key = null
  generation += 1
}

export function snapshot(): { key: CryptoKey | null; generation: number } {
  return { key, generation }
}

export function getKey(): CryptoKey | null {
  return key
}

export function getGeneration(): number {
  return generation
}

export function reset(): void {
  key = null
  generation = 0
}
