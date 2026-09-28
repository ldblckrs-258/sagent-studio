import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './types'

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init)

export function proxiedUrl(config: Pick<McpServerConfig, 'proxyUrl'>, target: string): string {
  return config.proxyUrl ? `${config.proxyUrl}${target}` : target
}

export function createMcpFetch(
  config: Pick<McpServerConfig, 'proxyUrl' | 'auth'>,
  baseFetch: FetchLike = defaultFetch,
): FetchLike {
  return (input, init) => {
    const target = input instanceof URL ? input.href : input
    const headers = new Headers(init?.headers)
    if (config.auth.kind === 'headers') {
      for (const [name, value] of Object.entries(config.auth.headers)) headers.set(name, value)
    }
    return baseFetch(proxiedUrl(config, target), { ...init, headers })
  }
}
