import type {
  PlaygroundModel,
  PlaygroundProviderId,
  PlaygroundProviderSettings,
  ProviderOutput,
  ProviderRun,
} from './types'

export interface PlaygroundProvider {
  readonly id: PlaygroundProviderId
  readonly retentionMs: number
  verify(signal?: AbortSignal): Promise<{ account: string }>
  getModel(slug: string, signal?: AbortSignal): Promise<PlaygroundModel>
  prepareImage(file: Blob, name: string, signal?: AbortSignal): Promise<string>
  start(model: PlaygroundModel, input: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderRun>
  poll(providerRunId: string, signal?: AbortSignal): Promise<ProviderRun>
  cancel(providerRunId: string): Promise<void>
  download(output: ProviderOutput, signal?: AbortSignal): Promise<{ blob: Blob; mime: string }>
}

export interface ProviderDeps {
  fetch?: typeof fetch
}

export interface ProviderDefinition {
  id: PlaygroundProviderId
  label: string
  tokenLabel: string
  tokenUrl: string
  defaultBaseURL: string
  quickModels: readonly string[]
  slugPattern: RegExp
  retentionMs: number
  create(config: PlaygroundProviderSettings, deps?: ProviderDeps): PlaygroundProvider
}
