import { describe, expect, it } from 'vitest'
import { checkOutputSchema, MAX_OUTPUT_SCHEMA_BYTES, validateJsonValue } from './structured'

const findings = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' } },
        required: ['file', 'line'],
      },
    },
  },
  required: ['verdict', 'issues'],
  additionalProperties: false,
}

describe('checkOutputSchema', () => {
  it('accepts an object schema', () => {
    expect(checkOutputSchema(findings)).toEqual({ ok: true, schema: findings })
  })

  it('rejects a schema that does not describe an object, since the result is a record', () => {
    expect(checkOutputSchema({ type: 'array' }).ok).toBe(false)
    expect(checkOutputSchema('object').ok).toBe(false)
    expect(checkOutputSchema(null).ok).toBe(false)
  })

  it('rejects a schema over the size limit so a request cannot flood the prompt', () => {
    const huge = {
      type: 'object',
      description: 'x'.repeat(MAX_OUTPUT_SCHEMA_BYTES),
    }
    const result = checkOutputSchema(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(String(MAX_OUTPUT_SCHEMA_BYTES))
  })
})

describe('validateJsonValue', () => {
  it('accepts a value that matches', () => {
    expect(
      validateJsonValue(findings, { verdict: 'fail', issues: [{ file: 'a.ts', line: 3 }] }),
    ).toBeNull()
  })

  it('names the first mismatch so the parent knows what the child got wrong', () => {
    expect(validateJsonValue(findings, { verdict: 'maybe', issues: [] })).toContain('$.verdict')
    expect(validateJsonValue(findings, { verdict: 'pass' })).toContain('$.issues is required')
    expect(
      validateJsonValue(findings, { verdict: 'pass', issues: [{ file: 'a.ts', line: 1.5 }] }),
    ).toContain('$.issues[0].line')
    expect(validateJsonValue(findings, { verdict: 'pass', issues: [], extra: 1 })).toContain(
      '$.extra',
    )
  })

  it('does not mistake inherited object keys for present properties', () => {
    const schema = { type: 'object', required: ['constructor', 'toString'] }
    expect(validateJsonValue(schema, {})).toContain('$.constructor is required')
  })

  it('treats anyOf as a union', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'null' }] }
    expect(validateJsonValue(schema, null)).toBeNull()
    expect(validateJsonValue(schema, 'x')).toBeNull()
    expect(validateJsonValue(schema, 1)).not.toBeNull()
  })
})
