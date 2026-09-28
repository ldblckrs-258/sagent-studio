import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { McpNotReadyError, McpSessionClosedError, NETWORK_OR_CORS_REASON } from './errors'
import { MCP_LIST_MAX, McpConnectionManager } from './manager'
import type { McpTransportFactory } from './manager'
import { inMemoryHarness, memoryPersistence, serverConfig } from './test-fixtures'

interface EchoServer {
  server: Server
  tools: Array<{ name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, unknown> } }>
}

function echoServer(): EchoServer {
  const state: EchoServer = {
    server: new Server(
      { name: 'echo-server', version: '1.2.3' },
      { capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} } },
    ),
    tools: [
      {
        name: 'echo',
        description: 'Echo text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
  }
  const { server } = state
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `echo:${String(request.params.arguments?.text)}` }],
  }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', description: 'Greet someone' }],
  }))
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
  }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'file:///readme.md', name: 'readme', mimeType: 'text/markdown' }],
  }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, text: '# readme' }],
  }))
  return state
}

async function ready(manager: McpConnectionManager, id = 'mcp_one'): Promise<void> {
  await vi.waitFor(() => {
    const state = manager.view(id)?.state
    if (state === 'error' || state === 'needs-auth') throw new Error(`failed: ${manager.view(id)?.reason}`)
    expect(state).toBe('ready')
  })
}

function httpManager(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, patch = {}) {
  const persistence = memoryPersistence([serverConfig(patch)])
  const calls: Array<{ url: string; method: string; accept: string | null }> = []
  const manager = new McpConnectionManager({
    persistence,
    redirectUrl: () => 'https://app.example.com/?mcp-oauth=callback',
    baseFetch: async (url, init) => {
      const href = url instanceof URL ? url.href : url
      calls.push({
        url: href,
        method: init?.method ?? 'GET',
        accept: new Headers(init?.headers).get('accept'),
      })
      return fetchImpl(href, init)
    },
  })
  return { manager, calls, persistence }
}

describe('McpConnectionManager with a real in-process server', () => {
  it('hydrates, auto-connects enabled servers, and exposes the whole catalog', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([
        serverConfig(),
        serverConfig({ id: 'mcp_off', name: 'Off', enabled: false }),
      ]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)

    const view = manager.view('mcp_one')!
    expect(view.serverInfo).toEqual({ name: 'echo-server', version: '1.2.3' })
    expect(view.catalog.tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(view.catalog.prompts.map((prompt) => prompt.name)).toEqual(['greet'])
    expect(view.catalog.resources.map((resource) => resource.uri)).toEqual(['file:///readme.md'])
    expect(manager.view('mcp_off')?.state).toBe('idle')
    expect(harness.connects).toBe(1)
    await manager.dispose()
  })

  it('calls tools, gets prompts, and reads resources through the live client', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)

    const result = await manager.callTool('mcp_one', 'echo', { text: 'hi' })
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }])
    const prompt = await manager.getPrompt('mcp_one', 'greet', {})
    expect(prompt.messages[0]?.content).toEqual({ type: 'text', text: 'hello' })
    const resource = await manager.readResource('mcp_one', 'file:///readme.md')
    expect(resource.contents[0]).toMatchObject({ text: '# readme' })
    await manager.dispose()
  })

  it('refreshes the tool catalog when the server announces tools/list_changed', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)

    harness.servers[0]!.tools.push({ name: 'added', inputSchema: { type: 'object' } })
    await harness.servers[0]!.server.sendToolListChanged()
    await vi.waitFor(() =>
      expect(manager.view('mcp_one')?.catalog.tools.map((tool) => tool.name)).toEqual([
        'echo',
        'added',
      ]),
    )
    await manager.dispose()
  })

  it('pages through tools/list with cursors and caps a runaway catalog', async () => {
    const pages = (cursor: string | undefined) => {
      const index = cursor ? Number(cursor) : 0
      const tools = Array.from({ length: 200 }, (_, offset) => ({
        name: `t${index * 200 + offset}`,
        inputSchema: { type: 'object' as const },
      }))
      return { tools, nextCursor: String(index + 1) }
    }
    const factory: McpTransportFactory = () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const server = new Server({ name: 'paged', version: '1' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async (request) => pages(request.params?.cursor))
      void server.connect(serverSide)
      return clientSide
    }
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: factory,
    })
    await manager.hydrate()
    await ready(manager)
    const view = manager.view('mcp_one')!
    expect(view.catalog.tools).toHaveLength(MCP_LIST_MAX)
    expect(view.catalog.tools[450]?.name).toBe('t450')
    expect(view.catalog.truncated).toEqual(['tools'])
    await manager.dispose()
  })

  it('reconnects once when the server drops the connection, then reports the second drop', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)

    await harness.serverTransports[0]!.close()
    await vi.waitFor(() => expect(harness.connects).toBe(2))
    await ready(manager)

    await harness.serverTransports[1]!.close()
    await vi.waitFor(() => expect(manager.view('mcp_one')?.state).toBe('error'))
    expect(manager.view('mcp_one')?.errorKind).toBe('closed')
    expect(harness.connects).toBe(2)
    await manager.dispose()
  })

  it('refuses every call after dispose, so nothing runs while the vault is locked', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)
    await manager.dispose()

    await expect(manager.callTool('mcp_one', 'echo', { text: 'x' })).rejects.toBeInstanceOf(
      McpSessionClosedError,
    )
    await expect(manager.connect('mcp_one')).rejects.toBeInstanceOf(McpSessionClosedError)
    expect(manager.views()).toEqual([])
  })

  it('refuses a call to a server that is not ready instead of queueing it', async () => {
    const harness = inMemoryHarness(echoServer)
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig({ enabled: false })]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await expect(manager.callTool('mcp_one', 'echo', {})).rejects.toBeInstanceOf(McpNotReadyError)
    await manager.dispose()
  })
})

describe('McpConnectionManager configuration changes', () => {
  it('reconnects only when a connection field changes', async () => {
    const harness = inMemoryHarness(echoServer)
    const persistence = memoryPersistence([serverConfig()])
    const manager = new McpConnectionManager({ persistence, transportFactory: harness.factory })
    await manager.hydrate()
    await ready(manager)

    await manager.saveServer(serverConfig({ name: 'Renamed' }))
    await manager.setToolEnabled('mcp_one', 'echo', false)
    expect(harness.connects).toBe(1)
    expect(persistence.entries.get('mcp_one')?.config.disabledTools).toEqual(['echo'])

    await manager.saveServer(serverConfig({ name: 'Renamed', url: 'https://other.example.com/mcp' }))
    await vi.waitFor(() => expect(harness.connects).toBe(2))
    await ready(manager)

    await manager.saveServer(serverConfig({ name: 'Renamed', url: 'https://other.example.com/mcp', enabled: false }))
    expect(manager.view('mcp_one')?.state).toBe('idle')
    await manager.dispose()
  })

  it('adds and removes servers, and rejects a name that collides with another tool prefix', async () => {
    const harness = inMemoryHarness(echoServer)
    const persistence = memoryPersistence([serverConfig()])
    const manager = new McpConnectionManager({ persistence, transportFactory: harness.factory })
    await manager.hydrate()

    await expect(manager.saveServer(serverConfig({ id: 'mcp_two', name: 'local' }))).rejects.toThrow(
      /collides/,
    )
    await manager.saveServer(serverConfig({ id: 'mcp_two', name: 'Second', enabled: false }))
    expect(manager.views().map((view) => view.config.id)).toEqual(['mcp_one', 'mcp_two'])

    await manager.removeServer('mcp_one')
    expect(manager.views().map((view) => view.config.id)).toEqual(['mcp_two'])
    expect(persistence.entries.has('mcp_one')).toBe(false)
    await manager.dispose()
  })
})

describe('McpConnectionManager over HTTP failures', () => {
  it('classifies a fetch TypeError as a network or CORS failure with the proxy hint', async () => {
    const { manager } = httpManager(async () => {
      throw new TypeError('Failed to fetch')
    })
    await manager.hydrate()
    await vi.waitFor(() => expect(manager.view('mcp_one')?.state).toBe('error'))
    expect(manager.view('mcp_one')?.errorKind).toBe('network_or_cors')
    expect(manager.view('mcp_one')?.reason).toBe(NETWORK_OR_CORS_REASON)
    await manager.dispose()
  })

  it('moves an OAuth server to needs-auth on 401 without contacting the auth server when it has no tokens', async () => {
    const oauth = httpManager(async () => new Response('no', { status: 401 }), { auth: { kind: 'oauth' } })
    await oauth.manager.hydrate()
    await vi.waitFor(() => expect(oauth.manager.view('mcp_one')?.state).toBe('needs-auth'))
    expect(oauth.calls).toEqual([])
    await oauth.manager.dispose()
  })

  it('asks for a new sign-in when stored tokens no longer work, instead of reporting a dead server', async () => {
    const oauth = httpManager(async () => new Response('no', { status: 401 }), { auth: { kind: 'oauth' } })
    await oauth.persistence.saveOAuth('mcp_one', () => ({
      tokens: { access_token: 'expired', token_type: 'Bearer' },
      clientInformation: { client_id: 'c' },
    }))
    await oauth.manager.hydrate()
    await vi.waitFor(() => expect(oauth.manager.view('mcp_one')?.state).toBe('needs-auth'))
    expect(oauth.calls.some((call) => call.url.endsWith('/register'))).toBe(false)
    await oauth.manager.dispose()
  })

  it('reports a header server that gets 401 as an error, because signing in cannot fix it', async () => {
    const headers = httpManager(async () => new Response('no', { status: 401 }), {
      auth: { kind: 'headers', headers: { Authorization: 'Bearer x' } },
    })
    await headers.manager.hydrate()
    await vi.waitFor(() => expect(headers.manager.view('mcp_one')?.state).toBe('error'))
    expect(headers.manager.view('mcp_one')?.reason).toMatch(/rejected the configured headers/)
    await headers.manager.dispose()
  })

  it('falls back to the legacy SSE transport in auto mode when Streamable HTTP is not offered', async () => {
    const { manager, calls } = httpManager(
      async (_url, init) =>
        init?.method === 'POST'
          ? new Response('method not allowed', { status: 405 })
          : new Response('gone', { status: 500 }),
      { transport: 'auto' },
    )
    await manager.hydrate()
    await vi.waitFor(() => expect(manager.view('mcp_one')?.state).toBe('error'))
    expect(calls[0]?.method).toBe('POST')
    expect(calls.some((call) => call.method === 'GET' && call.accept === 'text/event-stream')).toBe(true)
    await manager.dispose()
  })

  it('does not fall back on 401, so an auth problem is never hidden behind a transport retry', async () => {
    const { manager, calls } = httpManager(async () => new Response('no', { status: 401 }), {
      transport: 'auto',
    })
    await manager.hydrate()
    await vi.waitFor(() => expect(manager.view('mcp_one')?.state).toBe('error'))
    expect(calls.every((call) => call.method === 'POST')).toBe(true)
    await manager.dispose()
  })
})

function fakeAuthServer() {
  const requests: Array<{ method: string; url: string; body: string }> = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : ''
    requests.push({ method, url, body })
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] })
    }
    if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
      return json({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url === 'https://auth.example.com/register' && method === 'POST') {
      return json({ ...JSON.parse(body), client_id: 'dyn-1' }, 201)
    }
    if (url === 'https://auth.example.com/token' && method === 'POST') {
      const params = new URLSearchParams(body)
      if (params.get('code') !== 'the-code' || !params.get('code_verifier')) {
        return json({ error: 'invalid_grant' }, 400)
      }
      return json({ access_token: 'tok-1', token_type: 'Bearer', refresh_token: 'r-1' })
    }
    return new Response('not found', { status: 404 })
  }
  return { requests, fetchImpl }
}

function fakePopup() {
  const popup = {
    closed: false,
    navigatedTo: undefined as URL | undefined,
    close() {
      popup.closed = true
    },
    navigate(url: URL) {
      popup.navigatedTo = url
    },
  }
  return popup
}

describe('McpConnectionManager OAuth sign-in', () => {
  it('registers, authorizes with PKCE and state, stores tokens in the vault record, then connects', async () => {
    const auth = fakeAuthServer()
    const popup = fakePopup()
    const harness = inMemoryHarness(echoServer)
    const persistence = memoryPersistence([serverConfig({ auth: { kind: 'oauth' } })])
    const manager = new McpConnectionManager({
      persistence,
      transportFactory: harness.factory,
      baseFetch: (url, init) => auth.fetchImpl(url instanceof URL ? url.href : url, init),
      redirectUrl: () => 'https://app.example.com/?mcp-oauth=callback',
      openPopup: () => popup,
      waitForCallback: async ({ expectedState }) => {
        const authorize = popup.navigatedTo!
        expect(authorize.origin + authorize.pathname).toBe('https://auth.example.com/authorize')
        expect(authorize.searchParams.get('state')).toBe(expectedState)
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
        expect(authorize.searchParams.get('client_id')).toBe('dyn-1')
        expect(authorize.searchParams.get('redirect_uri')).toBe('https://app.example.com/?mcp-oauth=callback')
        return 'the-code'
      },
    })
    await manager.hydrate()
    await vi.waitFor(() => expect(manager.view('mcp_one')?.state).toBe('needs-auth'))
    expect(harness.connects).toBe(0)

    await manager.signIn('mcp_one')
    await ready(manager)
    expect(popup.closed).toBe(true)
    expect(harness.connects).toBe(1)
    const stored = persistence.entries.get('mcp_one')!.oauth
    expect(stored.tokens).toMatchObject({ access_token: 'tok-1', refresh_token: 'r-1' })
    expect(stored.clientInformation).toMatchObject({ client_id: 'dyn-1' })
    expect(auth.requests.some((request) => request.url === 'https://auth.example.com/token')).toBe(true)

    await manager.signOut('mcp_one')
    expect(persistence.entries.get('mcp_one')!.oauth).toEqual({})
    expect(manager.view('mcp_one')?.state).toBe('needs-auth')
    await manager.dispose()
  })

  it('stays in needs-auth with the reason when the user closes the window or the server refuses', async () => {
    const auth = fakeAuthServer()
    const popup = fakePopup()
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig({ auth: { kind: 'oauth' } })]),
      transportFactory: inMemoryHarness(echoServer).factory,
      baseFetch: (url, init) => auth.fetchImpl(url instanceof URL ? url.href : url, init),
      redirectUrl: () => 'https://app.example.com/?mcp-oauth=callback',
      openPopup: () => popup,
      waitForCallback: async () => {
        throw new Error('The sign-in window was closed before finishing.')
      },
    })
    await manager.hydrate()
    await manager.signIn('mcp_one')
    expect(manager.view('mcp_one')?.state).toBe('needs-auth')
    expect(manager.view('mcp_one')?.reason).toBe(
      'Sign-in failed: The sign-in window was closed before finishing.',
    )
    expect(popup.closed).toBe(true)
    await manager.dispose()
  })

  it('explains a blocked pop-up instead of failing silently', async () => {
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig({ auth: { kind: 'oauth' } })]),
      redirectUrl: () => 'https://app.example.com/?mcp-oauth=callback',
      openPopup: () => null,
    })
    await manager.hydrate()
    await manager.signIn('mcp_one')
    expect(manager.view('mcp_one')?.reason).toMatch(/blocked the sign-in window/)
    await manager.dispose()
  })

  it('forgets OAuth tokens when the user switches the server away from OAuth', async () => {
    const persistence = memoryPersistence([serverConfig({ auth: { kind: 'oauth' }, enabled: false })])
    await persistence.saveOAuth('mcp_one', () => ({ tokens: { access_token: 't' } }))
    const manager = new McpConnectionManager({ persistence })
    await manager.hydrate()
    await manager.saveServer(serverConfig({ auth: { kind: 'none' }, enabled: false }))
    expect(persistence.entries.get('mcp_one')!.oauth).toEqual({})
    await manager.dispose()
  })
})

describe('McpConnectionManager review fixes', () => {
  it('comes back after a StrictMode-style dispose and ignores the stale hydrate', async () => {
    const harness = inMemoryHarness(echoServer)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const persistence = memoryPersistence([serverConfig()])
    const slowList = persistence.list
    let calls = 0
    persistence.list = async () => {
      calls += 1
      if (calls === 1) await gate
      return slowList()
    }
    const manager = new McpConnectionManager({ persistence, transportFactory: harness.factory })
    const stale = manager.hydrate()
    await manager.dispose()
    manager.revive()
    await manager.hydrate()
    await ready(manager)
    release()
    await stale
    expect(harness.connects).toBe(1)
    expect(manager.isDisposed()).toBe(false)
    await manager.dispose()
  })

  it('forgets OAuth state when the URL, proxy, or client changes, so a token never reaches another host', async () => {
    const persistence = memoryPersistence([serverConfig({ auth: { kind: 'oauth' }, enabled: false })])
    const manager = new McpConnectionManager({ persistence })
    await manager.hydrate()
    const seed = () => persistence.saveOAuth('mcp_one', () => ({ tokens: { access_token: 't' } }))

    await seed()
    await manager.saveServer(serverConfig({ name: 'Renamed', auth: { kind: 'oauth' }, enabled: false, timeoutMs: 9_000 }))
    expect(persistence.entries.get('mcp_one')!.oauth.tokens).toEqual({ access_token: 't' })

    await manager.saveServer(serverConfig({ name: 'Renamed', url: 'https://other.example.com/mcp', auth: { kind: 'oauth' }, enabled: false }))
    expect(persistence.entries.get('mcp_one')!.oauth).toEqual({})

    await seed()
    await manager.saveServer(serverConfig({ name: 'Renamed', url: 'https://other.example.com/mcp', proxyUrl: 'https://p.example.com/', auth: { kind: 'oauth' }, enabled: false }))
    expect(persistence.entries.get('mcp_one')!.oauth).toEqual({})

    await seed()
    await manager.saveServer(serverConfig({ name: 'Renamed', url: 'https://other.example.com/mcp', proxyUrl: 'https://p.example.com/', auth: { kind: 'oauth', clientId: 'new' }, enabled: false }))
    expect(persistence.entries.get('mcp_one')!.oauth).toEqual({})
    await manager.dispose()
  })

  it('resets saved tool decisions when a server is removed, repointed, or renamed', async () => {
    const forgotten: string[] = []
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig({ name: 'GitHub', enabled: false })]),
      forgetToolDecisions: (name) => forgotten.push(name),
    })
    await manager.hydrate()
    await manager.saveServer(serverConfig({ name: 'GitHub', enabled: false, timeoutMs: 9_000 }))
    expect(forgotten).toEqual([])
    await manager.saveServer(serverConfig({ name: 'GitHub', url: 'https://evil.example.com/mcp', enabled: false }))
    await manager.saveServer(serverConfig({ name: 'Hub', url: 'https://evil.example.com/mcp', enabled: false }))
    await manager.removeServer('mcp_one')
    expect(forgotten).toEqual(['GitHub', 'GitHub', 'Hub'])
    await manager.dispose()
  })

  it('keeps both catalogs when tools and prompts change at the same time', async () => {
    const harness = inMemoryHarness(() => {
      const built = echoServer()
      built.server.registerCapabilities({ prompts: { listChanged: true } })
      return built
    })
    const manager = new McpConnectionManager({
      persistence: memoryPersistence([serverConfig()]),
      transportFactory: harness.factory,
    })
    await manager.hydrate()
    await ready(manager)
    const server = harness.servers[0]!
    server.tools.push({ name: 'added', inputSchema: { type: 'object' } })
    await Promise.all([server.server.sendToolListChanged(), server.server.sendPromptListChanged()])
    await vi.waitFor(() =>
      expect(manager.view('mcp_one')?.catalog.tools.map((tool) => tool.name)).toEqual(['echo', 'added']),
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(manager.view('mcp_one')?.catalog.tools.map((tool) => tool.name)).toEqual(['echo', 'added'])
    expect(manager.view('mcp_one')?.catalog.prompts.map((prompt) => prompt.name)).toEqual(['greet'])
    await manager.dispose()
  })
})
