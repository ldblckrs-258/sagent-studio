import { generateText, jsonSchema, Output } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'

export const MAX_OUTPUT_SCHEMA_BYTES = 8 * 1024

const EXTRACT_SYSTEM =
  'You convert a finished agent run into one JSON object that matches the given schema. Use only facts the run established. Where the run did not establish a required value, use the closest honest value the schema allows (an empty string, an empty list, or null when permitted). Output the JSON object only.'

const EXTRACT_REQUEST =
  'Return the result of the work above as a single JSON object that matches the schema.'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function checkOutputSchema(value: unknown): { ok: true; schema: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlainObject(value)) return { ok: false, message: 'outputSchema must be a JSON Schema object.' }
  if (value.type !== 'object') {
    return { ok: false, message: 'outputSchema must describe an object: set "type": "object".' }
  }
  const size = new TextEncoder().encode(JSON.stringify(value)).length
  if (size > MAX_OUTPUT_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `outputSchema is ${size} bytes; the limit is ${MAX_OUTPUT_SCHEMA_BYTES} bytes.`,
    }
  }
  return { ok: true, schema: value }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function validateJsonValue(schema: unknown, value: unknown, path = '$'): string | null {
  if (schema === true || schema === undefined) return null
  if (schema === false) return `${path} is not allowed.`
  if (!isPlainObject(schema)) return null

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((option) => validateJsonValue(option, value, path) === null)
    if (!matched) return `${path} matches none of the allowed shapes.`
  }

  const types = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : []
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    return `${path} must be ${types.join(' or ')}.`
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value))) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}.`
  }
  if (Object.hasOwn(schema, 'const') && !sameValue(schema.const, value)) {
    return `${path} must equal ${JSON.stringify(schema.const)}.`
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) return `${path}.${key} is required.`
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const error = validateJsonValue(properties[key], entry, `${path}.${key}`)
        if (error) return error
      } else if (schema.additionalProperties !== undefined) {
        const error = validateJsonValue(schema.additionalProperties, entry, `${path}.${key}`)
        if (error) return error
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined && !Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonValue(schema.items, value[index], `${path}[${index}]`)
      if (error) return error
    }
  }

  return null
}

export async function extractStructured(input: {
  model: LanguageModel
  history: readonly ModelMessage[]
  schema: Record<string, unknown>
  signal?: AbortSignal
}): Promise<{ value: unknown; usage: LanguageModelUsage }> {
  const schema = jsonSchema<unknown>(input.schema as Parameters<typeof jsonSchema>[0], {
    validate: (value) => {
      const error = validateJsonValue(input.schema, value)
      return error === null
        ? { success: true, value }
        : { success: false, error: new Error(`The result does not match outputSchema: ${error}`) }
    },
  })
  const result = await generateText({
    model: input.model,
    system: EXTRACT_SYSTEM,
    messages: [...input.history, { role: 'user', content: EXTRACT_REQUEST }],
    output: Output.object({ schema }),
    ...(input.signal ? { abortSignal: input.signal } : {}),
  })
  return { value: result.output, usage: result.usage }
}
