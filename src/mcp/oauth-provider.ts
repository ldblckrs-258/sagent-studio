import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServerPersistence } from './store'
import type { McpOAuthState, McpServerConfig } from './types'

export class McpOAuthRedirectRequired extends Error {
  constructor(options?: ErrorOptions) {
    super('This server needs a sign-in before it can connect.', options)
    this.name = 'McpOAuthRedirectRequired'
  }
}

export interface VaultOAuthProviderOptions {
  config: McpServerConfig
  persistence: McpServerPersistence
  redirectUrl: string
  navigate?: (url: URL) => void
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class VaultOAuthProvider implements OAuthClientProvider {
  private readonly config: McpServerConfig
  private readonly persistence: McpServerPersistence
  private readonly redirect: string
  private readonly navigate: ((url: URL) => void) | undefined
  private expectedState: string | undefined

  constructor(options: VaultOAuthProviderOptions) {
    this.config = options.config
    this.persistence = options.persistence
    this.redirect = options.redirectUrl
    this.navigate = options.navigate
  }

  get redirectUrl(): string {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    const auth = this.config.auth.kind === 'oauth' ? this.config.auth : undefined
    return {
      client_name: 'sagent-studio',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: auth?.clientSecret ? 'client_secret_post' : 'none',
      ...(auth?.scopes ? { scope: auth.scopes } : {}),
    }
  }

  state(): string {
    this.expectedState = randomState()
    return this.expectedState
  }

  private get interactive(): boolean {
    return this.navigate !== undefined
  }

  pendingState(): string | undefined {
    return this.expectedState
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.auth.kind === 'oauth' && this.config.auth.clientId) {
      return {
        client_id: this.config.auth.clientId,
        ...(this.config.auth.clientSecret ? { client_secret: this.config.auth.clientSecret } : {}),
      }
    }
    return (await this.read()).clientInformation as OAuthClientInformationMixed | undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.write((current) => ({ ...current, clientInformation }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens as OAuthTokens | undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write((current) => ({ ...current, tokens }))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.navigate) throw new McpOAuthRedirectRequired()
    this.navigate(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.interactive) return
    await this.write((current) => ({ ...current, codeVerifier }))
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.read()).codeVerifier
    if (!verifier) throw new Error('No PKCE code verifier is stored for this sign-in.')
    return verifier
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.write((current) => ({ ...current, discoveryState: state }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState as OAuthDiscoveryState | undefined
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    await this.write((current) => {
      if (scope === 'all') return {}
      const next = { ...current }
      if (scope === 'client') delete next.clientInformation
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.codeVerifier
      if (scope === 'discovery') delete next.discoveryState
      return next
    })
  }

  private async read(): Promise<McpOAuthState> {
    return (await this.persistence.get(this.config.id))?.oauth ?? {}
  }

  private async write(update: (current: McpOAuthState) => McpOAuthState): Promise<void> {
    await this.persistence.saveOAuth(this.config.id, update)
  }
}
