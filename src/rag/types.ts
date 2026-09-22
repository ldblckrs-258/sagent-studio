export type DocumentKind = 'text' | 'markdown' | 'pdf'

/**
 * The decrypted metadata of one library document. Persisted only inside the
 * document's encrypted blob; nothing here is readable before unlock.
 */
export interface DocumentMeta {
  id: string
  title: string
  kind: DocumentKind
  /** The original file name, kept for display. */
  sourceName: string
  byteSize: number
  chunkCount: number
  /** Token counts, not characters. */
  chunkSize: number
  overlap: number
  embedProviderId: string
  embedModel: string
  dims: number
  createdAt: number
  updatedAt: number
}

/** A chunk before it is embedded and encrypted. */
export interface ChunkDraft {
  ordinal: number
  text: string
}

/** A chunk after decryption: plaintext text and a rebuilt vector. */
export interface StoredChunk {
  id: string
  docId: string
  ordinal: number
  dims: number
  text: string
  vector: Float32Array
}

export type IngestPhase = 'extracting' | 'chunking' | 'embedding' | 'persisting'

export interface IngestProgress {
  phase: IngestPhase
  done: number
  total: number
}

export interface IngestSuccess {
  ok: true
  id: string
  title: string
  kind: DocumentKind
  chunkCount: number
  dims: number
}

export interface IngestFailure {
  ok: false
  title: string
  kind: DocumentKind
  error: string
}

export type IngestResult = IngestSuccess | IngestFailure
