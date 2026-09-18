import type { Bytes, EncryptedBlob, KdfParams } from './types'
import type { Settings } from './settings'

function fromB64(value: string): Bytes {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const FIXTURE_SALT = fromB64('AQIDBAUGBwgJCgsMDQ4PEA==')
const FIXTURE_IV = fromB64('CgsMDQ4PEBESExQV')
const FIXTURE_CIPHERTEXT = fromB64(
  'UxoehPRtaZm+1UlbVd6B7WOULD6gw539U/Qe4udXCSQKvP6fhtedsVS7zVvrHx9M3c3cmUl/uNQ4z1zNAlVYoWGiYccjeJMrx/3Ktfa9c9QNcpnSQn2FpehQpV49ZeCr/nq/fDgPJOJeXCuIO3JqTkWGrKqCbfXTAcoajqNYdDGQ+vQxabVs6/wzxVka9b82WEvhVPxIgB8tEsoWhqZc7ta/6yxZwVJPOAvjoJVGAdpQuecv78UKvh/pf4cwsHB35z3InjXpJQpJDrrdv+YkL+eLY06L5A1eEl/lN6H/ut7yX96WauaOieQ3PXOTLlrn4AT9izlue+NrlXDLfDnGARexyp25TCkopqWoWxqQvKJ34M+wQ4Ukf0ogw18C5QXqDSEk+61lA67rVQD3p8R5HawdHZPTu7koxhkWgNfu0R4RalJmzyajo9hmftYzOuGZJteEUsBwk/euRCW25YQ1xz0QuXm87DBZ+OSyPbX4DoxisTLxtgX4gjlyk3rAr6mjPSMkxpJQeHFKIRjgvNdz6sme93a2dMePho41fA/epeWqn7t/MGCDriOd62jZSCsSvjUZXoZg+TTS1X7FSATAL8ndHykDBLawPg==',
)
const FIXTURE_CANARY_IV = fromB64('Hh8gISIjJCUmJygp')
const FIXTURE_CANARY_CIPHERTEXT = fromB64('4/mtWGZTcpny1iOXiKg9VGO6cXHliRjTS2KOkjWqJg==')

export const FIXTURE_PASSWORD = 'fixture-password'

export const FIXTURE_KDF_PARAMS: KdfParams = {
  algorithm: 'PBKDF2-SHA256',
  iterations: 1000,
  salt: FIXTURE_SALT,
}

export const FIXTURE_BLOB: EncryptedBlob = {
  iv: FIXTURE_IV,
  ciphertext: FIXTURE_CIPHERTEXT,
}

export const FIXTURE_CANARY: EncryptedBlob = {
  iv: FIXTURE_CANARY_IV,
  ciphertext: FIXTURE_CANARY_CIPHERTEXT,
}

export const FIXTURE_SETTINGS: Settings = {
  version: 1,
  providers: [
    {
      id: 'local',
      label: 'Local Ollama',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'fixture-provider-key',
      models: ['llama3'],
      defaultModel: 'llama3',
    },
  ],
  typesafe: { apiKey: 'fixture-typesafe-key', model: 'jev-latest' },
  rag: {
    embedModel: 'text-embedding-3-small',
    chunkSize: 1000,
    overlap: 200,
    topK: 5,
    thresholds: {},
    concurrency: 2,
  },
  egressNoticeDismissed: false,
  idleLockMinutes: 15,
}
