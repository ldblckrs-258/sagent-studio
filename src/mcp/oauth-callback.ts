export const MCP_OAUTH_CHANNEL = 'sagent-mcp-oauth'
export const MCP_OAUTH_PARAM = 'mcp-oauth'
export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000
export const MCP_OAUTH_POPUP_POLL_MS = 500

export interface McpOAuthCallback {
  state: string | null
  code: string | null
  error: string | null
  errorDescription: string | null
}

export class McpOAuthCallbackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpOAuthCallbackError'
  }
}

export function mcpOAuthRedirectUrl(location: Pick<Location, 'origin' | 'pathname'>): string {
  return `${location.origin}${location.pathname}?${MCP_OAUTH_PARAM}=callback`
}

export function parseMcpOAuthCallback(search: string): McpOAuthCallback | null {
  const params = new URLSearchParams(search)
  if (params.get(MCP_OAUTH_PARAM) !== 'callback') return null
  return {
    state: params.get('state'),
    code: params.get('code'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  }
}

export function isMcpOAuthCallback(search: string): boolean {
  return parseMcpOAuthCallback(search) !== null
}

export function handleMcpOAuthCallback(
  win: Pick<Window, 'close'> & { location: Pick<Location, 'search'> },
  createChannel: (name: string) => Pick<BroadcastChannel, 'postMessage' | 'close'> = (name) =>
    new BroadcastChannel(name),
): boolean {
  const callback = parseMcpOAuthCallback(win.location.search)
  if (!callback) return false
  const channel = createChannel(MCP_OAUTH_CHANNEL)
  channel.postMessage(callback)
  channel.close()
  win.close()
  return true
}

function isCallback(value: unknown): value is McpOAuthCallback {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return ['state', 'code', 'error', 'errorDescription'].every(
    (key) => record[key] === null || typeof record[key] === 'string',
  )
}

export interface WaitForCallbackOptions {
  expectedState: string
  isPopupClosed: () => boolean
  timeoutMs?: number
  pollMs?: number
  createChannel?: (name: string) => Pick<BroadcastChannel, 'addEventListener' | 'close'>
}

export function waitForMcpOAuthCallback(options: WaitForCallbackOptions): Promise<string> {
  const createChannel = options.createChannel ?? ((name: string) => new BroadcastChannel(name))
  return new Promise((resolve, reject) => {
    const channel = createChannel(MCP_OAUTH_CHANNEL)
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(poll)
      channel.close()
      outcome()
    }
    const timeout = setTimeout(
      () => finish(() => reject(new McpOAuthCallbackError('Sign-in timed out. Try again.'))),
      options.timeoutMs ?? MCP_OAUTH_TIMEOUT_MS,
    )
    const poll = setInterval(() => {
      if (options.isPopupClosed()) {
        finish(() => reject(new McpOAuthCallbackError('The sign-in window was closed before finishing.')))
      }
    }, options.pollMs ?? MCP_OAUTH_POPUP_POLL_MS)
    channel.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data
      if (!isCallback(data) || data.state !== options.expectedState) return
      if (data.error !== null) {
        const detail = data.errorDescription ? `: ${data.errorDescription}` : ''
        finish(() => reject(new McpOAuthCallbackError(`The server refused sign-in (${data.error})${detail}`)))
        return
      }
      if (!data.code) {
        finish(() => reject(new McpOAuthCallbackError('The sign-in response had no authorization code.')))
        return
      }
      const code = data.code
      finish(() => resolve(code))
    })
  })
}
