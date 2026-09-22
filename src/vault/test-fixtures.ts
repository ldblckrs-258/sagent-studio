import type { Bytes, EncryptedBlob, KdfParams } from './types'
import type { Settings } from './settings'

function fromB64(value: string): Bytes {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const FIXTURE_SALT = fromB64('AQIDBAUGBwgJCgsMDQ4PEA==')
const FIXTURE_IV = fromB64('dnZTaXUxH0HB0z1T')
const FIXTURE_CIPHERTEXT = fromB64(
  'xi9lDtl3q5m82AZaqdcDHXbOe68Hxx0BYrpMEsNrdoZEp6HCCHVDbYiCX7XiBpKIRhejVzZiHruJ/2P7t9Y+WNBlGTZ9nSg3xD970GIGFlrbYP1lZP+2PMv9w1/eQwqejagtjvnLZPF4jtJ72xHNPjer1QXxKS5hE3ozEbPAEupba8NAeydRST2W3K2kAYiwuA7eutGP9/FrwpmWMMW6SokS6wTmkUAz7ttGpI+BFzNedhVETGHNoEfBWtWnhTfbB67TbFc/qFW/Yehe9E6OJ14U7Myj/D3AAmqTQhwd2DuIkvsvbNQyR/RHqx9j5gasHcDth2diLScFLviwHWChWmGSor5/Pg31cmNKZSs1Vxg7mlLIZZ0Wr0nkbIKR9OUgS7m+Q6GGL/anU3zmmRWBN0h7t3iWJ3jw3vZCQ4+vrJjHq0oAktTARf4EFOuKjergqwqctOTAM2CsKaMuU3j4jEzwPzQK91hPHUy5bQ3aLuP7+D1eXvaRG45gjHSFRiFKT4BalpI7tMwjuWcAhUS/vf+8ddvc4YjPRB4u/sWUk149SljGfAVESkx5os9KExKLfiMBBmW4Ve9FqMMPPGmJYXi1il4RffG7iiO5Ny3N/DIDYa/o3+wwNNge4Tg4qVdhsbUkNMYN1B6gJZncXlXQ2EHtBLZpPSWjDbWVmVijdvkWx91bL725TWV3SRXmGBGVqNlS9N4xNckAkM2PHAx4Zhw5djZL6inQfpgkbEF1PtMfSyBb9TSvboLpgVO3Xe1yFUWB/zoHRhu5q/BJIxHjmOEcHPOeQBY2O7DkcmwKwUnmPHtrr59SQT19H3ea+k/x1G20iJQzAoldiW0otSKbNo7usDmCotNnYgqaHW+oqoG5GekIkKQTNA==',
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
      models: [{ id: 'llama3' }],
      defaultModel: 'llama3',
    },
  ],
  typesafe: { apiKey: 'fixture-typesafe-key', model: 'jev-latest' },
  rag: {
    embedModel: 'text-embedding-3-small',
    chunkSize: 400,
    overlap: 60,
    topK: 5,
    thresholds: {},
    concurrency: 4,
  },
  sandbox: {
    enabled: true,
    jsTimeoutMs: 10_000,
    pyTimeoutMs: 30_000,
    idleTimeoutMs: 300_000,
  },
  approvals: { tools: {} },
  context: {
    maxContextTokens: 128_000,
    autoCompactRatio: 0.9,
    autoCompactEnabled: true,
  },
  egressNoticeDismissed: false,
  idleLockMinutes: 15,
}
