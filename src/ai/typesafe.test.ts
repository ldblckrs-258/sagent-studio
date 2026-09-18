import { describe, expect, it, vi } from 'vitest'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createTypeSafe, TypeSafeConfigError } from './typesafe'
import { defaultSettings } from '../vault/settings'

function settingsWithTypesafe(patch: Partial<ReturnType<typeof defaultSettings>['typesafe']>) {
  const settings = defaultSettings()
  return { ...settings, typesafe: { ...settings.typesafe, ...patch } }
}

describe('createTypeSafe', () => {
  it('constructs with a valid key and pins logLevel to warn', () => {
    const client = createTypeSafe(settingsWithTypesafe({ apiKey: 'ts-key' }))
    expect(client).toBeTruthy()
    expect(client.logLevel).toBe('warn')
    expect(client.defaultModel).toBe('jev-latest')
  })

  it('defaults to jev-latest when no model is set', () => {
    const client = createTypeSafe(settingsWithTypesafe({ apiKey: 'ts-key', model: '' }))
    expect(client.defaultModel).toBe('jev-latest')
  })

  it('throws TypeSafeConfigError when the api key is missing', () => {
    expect(() => createTypeSafe(settingsWithTypesafe({ apiKey: '' }))).toThrow(TypeSafeConfigError)
  })

  it('accepts a base URL override', () => {
    const client = createTypeSafe(
      settingsWithTypesafe({ apiKey: 'ts-key', baseURL: 'https://example.test' }),
    )
    expect(client.baseURL).toBe('https://example.test')
  })

  it('pins logLevel so a spy logger never receives request bodies', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const client = new TypeSafeClient({
      apiKey: 'ts-key',
      logLevel: 'warn',
      logger: spy,
      dangerouslyAllowBrowser: true,
    })
    expect(client.logLevel).toBe('warn')
    client.logger.debug('request body: SECRET_QUERY_TEXT')
    client.logger.info('request body: SECRET_QUERY_TEXT')
    expect(spy.debug).not.toHaveBeenCalled()
    expect(spy.info).not.toHaveBeenCalled()
  })
})
