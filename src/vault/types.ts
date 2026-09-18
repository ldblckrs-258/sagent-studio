export type Bytes = Uint8Array<ArrayBuffer>

export type KdfParams =
  | { algorithm: 'PBKDF2-SHA256'; iterations: number; salt: Bytes }
  | { algorithm: 'argon2id'; memoryKiB: number; iterations: number; salt: Bytes }

export interface EncryptedBlob {
  iv: Bytes
  ciphertext: Bytes
}
