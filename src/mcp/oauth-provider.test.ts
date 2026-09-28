import { describe, expect, it, vi } from 'vitest'
import { McpOAuthRedirectRequired, VaultOAuthProvider } from './oauth-provider'
import { memoryPersistence, serverConfig } from './test-fixtures'

const REDIRECT = 'https://app.example.com/?mcp-oauth=callback'

function provider(auth: Parameters<typeof serverConfig>[0] = {}, navigate?: (url: URL) => void) {
  const config = serverConfig({ auth: { kind: 'oauth' }, ...auth })
  const persistence = memoryPersistence([config])
  return {
    persistence,
    provider: new VaultOAuthProvider({
      config,
      persistence,
      redirectUrl: REDIRECT,
      ...(navigate ? { navigate } : {}),
    }),
  }
}

describe('VaultOAuthProvider', () => {
  it('round-trips tokens, verifier, client registration, and discovery through the vault record', async () => {
    const { provider: oauth, persistence } = provider({}, vi.fn())
    await oauth.saveTokens({ access_token: 'a', token_type: 'Bearer' })
    await oauth.saveCodeVerifier('verifier')
    await oauth.saveClientInformation({ client_id: 'dyn' })
    await oauth.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' })

    expect(await oauth.tokens()).toEqual({ access_token: 'a', token_type: 'Bearer' })
    expect(await oauth.codeVerifier()).toBe('verifier')
    expect(await oauth.clientInformation()).toEqual({ client_id: 'dyn' })
    expect(await oauth.discoveryState()).toEqual({ authorizationServerUrl: 'https://auth.example.com' })
    expect(persistence.entries.get('mcp_one')?.oauth.tokens).toEqual({
      access_token: 'a',
      token_type: 'Bearer',
    })
  })

  it('prefers a manually entered client over a dynamic registration', async () => {
    const { provider: oauth } = provider({
      auth: { kind: 'oauth', clientId: 'manual', clientSecret: 'shh', scopes: 'read write' },
    })
    await oauth.saveClientInformation({ client_id: 'dyn' })
    expect(await oauth.clientInformation()).toEqual({ client_id: 'manual', client_secret: 'shh' })
    expect(oauth.clientMetadata).toMatchObject({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'read write',
    })
  })

  it('registers as a public client when there is no secret', () => {
    expect(provider().provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('refuses to redirect when not in an interactive sign-in, so auto-connect never opens a window', () => {
    expect(() => provider().provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).toThrow(
      McpOAuthRedirectRequired,
    )
  })

  it('navigates the sign-in window during an interactive sign-in', () => {
    const navigate = vi.fn()
    const url = new URL('https://auth.example.com/authorize')
    provider({}, navigate).provider.redirectToAuthorization(url)
    expect(navigate).toHaveBeenCalledWith(url)
  })

  it('issues a fresh unguessable state per attempt and remembers it for the callback check', () => {
    const { provider: oauth } = provider()
    const first = oauth.state()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(oauth.pendingState()).toBe(first)
    expect(oauth.state()).not.toBe(first)
  })

  it('invalidates only the requested part, or everything', async () => {
    const { provider: oauth } = provider()
    await oauth.saveTokens({ access_token: 'a', token_type: 'Bearer' })
    await oauth.saveClientInformation({ client_id: 'dyn' })
    await oauth.invalidateCredentials('tokens')
    expect(await oauth.tokens()).toBeUndefined()
    expect(await oauth.clientInformation()).toEqual({ client_id: 'dyn' })
    await oauth.invalidateCredentials('all')
    expect(await oauth.clientInformation()).toBeUndefined()
  })

  it('fails loudly when asked for a verifier that was never stored', async () => {
    await expect(provider().provider.codeVerifier()).rejects.toThrow(/No PKCE code verifier/)
  })
})

describe('VaultOAuthProvider outside a sign-in', () => {
  it('never stores a PKCE verifier, so a background connect cannot clobber an active sign-in', async () => {
    const { provider: background, persistence } = provider()
    await background.saveCodeVerifier('background')
    expect(persistence.entries.get('mcp_one')?.oauth.codeVerifier).toBeUndefined()
    const { provider: interactive, persistence: other } = provider({}, vi.fn())
    await interactive.saveCodeVerifier('interactive')
    expect(other.entries.get('mcp_one')?.oauth.codeVerifier).toBe('interactive')
  })
})
