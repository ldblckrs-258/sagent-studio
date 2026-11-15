import type { PlaygroundProviderId } from '../vault/settings'

export type { PlaygroundProviderId, PlaygroundProviderSettings } from '../vault/settings'

export type RunStatus =
  | 'starting'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'expired'

export function isTerminal(status: RunStatus): boolean {
  return status !== 'starting' && status !== 'processing'
}

interface FormFieldBase {
  name: string
  label: string
  description?: string
  required: boolean
  default?: unknown
  nullable: boolean
  secret: boolean
}

export type FormFieldShape =
  | { kind: 'text'; multiline: boolean }
  | { kind: 'select'; options: readonly (string | number)[] }
  | { kind: 'integer' | 'number'; min?: number; max?: number; step: number }
  | { kind: 'boolean' }
  | { kind: 'image' }
  | { kind: 'images' }
  | { kind: 'json' }

export type FormField = FormFieldBase & FormFieldShape

export interface PlaygroundModel {
  providerId: PlaygroundProviderId
  slug: string
  label: string
  description?: string
  fields: FormField[]
  editsImages: boolean
  ref: unknown
}

export interface ProviderOutput {
  url: string
  mime?: string
}

export interface ProviderRun {
  providerRunId: string
  status: RunStatus
  outputs?: ProviderOutput[]
  outputJson?: unknown
  error?: string
  predictTime?: number
}
