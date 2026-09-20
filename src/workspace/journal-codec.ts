import type { JournalCheckpoint, JournalEntry, JournalSnapshot } from './journal'

/**
 * Encodes a journal snapshot for storage. The payload is gzipped when the
 * platform exposes `CompressionStream` (all current browsers), which shrinks
 * source snapshots dramatically; a plain JSON fallback keeps older runtimes and
 * tests working. The result is a string because the vault's `encryptRecord`
 * takes plaintext text.
 */
export const JOURNAL_ENVELOPE_VERSION = 1

const COMPRESSED_PREFIX = 'gz:'
const decoder = new TextDecoder()

interface JournalEnvelope {
  version: number
  journal: JournalSnapshot
}

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function gzip(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return `${COMPRESSED_PREFIX}${bytesToBase64(new Uint8Array(buffer))}`
}

async function gunzip(text: string): Promise<string> {
  const bytes = base64ToBytes(text)
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return decoder.decode(buffer)
}

export async function encodeJournal(state: JournalSnapshot): Promise<string> {
  const json = JSON.stringify({ version: JOURNAL_ENVELOPE_VERSION, journal: state } satisfies JournalEnvelope)
  if (!hasCompression()) return json
  try {
    return await gzip(json)
  } catch {
    return json
  }
}

function parseSnapshot(value: unknown): JournalSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const envelope = value as { version?: unknown; journal?: unknown }
  if (typeof envelope.version !== 'number' || envelope.version > JOURNAL_ENVELOPE_VERSION) return null
  const journal = envelope.journal as { seq?: unknown; entries?: unknown; checkpoints?: unknown } | undefined
  if (typeof journal !== 'object' || journal === null) return null
  if (!Array.isArray(journal.entries) || !Array.isArray(journal.checkpoints)) return null
  return {
    seq: typeof journal.seq === 'number' && Number.isFinite(journal.seq) ? journal.seq : 0,
    entries: journal.entries as JournalEntry[],
    checkpoints: journal.checkpoints as JournalCheckpoint[],
  }
}

/** Returns null for a corrupt or future-version payload rather than throwing. */
export async function decodeJournal(raw: string): Promise<JournalSnapshot | null> {
  let json = raw
  if (raw.startsWith(COMPRESSED_PREFIX)) {
    try {
      json = await gunzip(raw.slice(COMPRESSED_PREFIX.length))
    } catch {
      return null
    }
  }
  try {
    return parseSnapshot(JSON.parse(json))
  } catch {
    return null
  }
}
