/**
 * A cheap, stable content fingerprint used for optimistic concurrency. It is not
 * cryptographic: it only needs to change when the bytes change, so a model can
 * pass `expect_revision` back to detect a stale write.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function revisionOf(text: string): string {
  return contentHash(text)
}
