import { describe, expect, it } from 'vitest'
import { fromHttp, MAX_ERROR_MESSAGE, redactToken } from './errors'

describe('fromHttp', () => {
  it('prefers the provider detail, so the user sees why the run was rejected', () => {
    const error = fromHttp(422, { title: 'Input validation failed', detail: '- prompt: Required' })
    expect(error.code).toBe('invalid_input')
    expect(error.status).toBe(422)
    expect(error.message).toBe('- prompt: Required')
  })

  it('falls back to the title, then to the caller sentence, then to a fixed sentence per code', () => {
    expect(fromHttp(402, { title: 'Insufficient credit' }).message).toBe('Insufficient credit')
    expect(fromHttp(404, {}, { not_found: 'No such model.' }).message).toBe('No such model.')
    expect(fromHttp(429, 'not json').code).toBe('rate_limited')
    expect(fromHttp(401, null).message).toMatch(/token/)
    expect(fromHttp(503, null)).toMatchObject({ code: 'http', message: 'The provider returned HTTP 503.' })
    expect(fromHttp(413, null).code).toBe('too_large')
  })

  it('caps the message length so a hostile body cannot flood the UI', () => {
    expect(fromHttp(422, { detail: 'x'.repeat(5000) }).message.length).toBe(MAX_ERROR_MESSAGE)
  })
})

describe('redactToken', () => {
  it('removes the exact token, which generic patterns do not recognise', () => {
    const token = 'r8_AbCdEf0123456789'
    const message = redactToken(`Token ${token} is invalid; again ${token}`, token)
    expect(message).not.toContain(token)
    expect(message).toContain('[redacted]')
  })

  it('also scrubs bearer headers and still works with an empty token', () => {
    expect(redactToken('Authorization: Bearer abc.def', '')).not.toContain('abc.def')
  })
})
