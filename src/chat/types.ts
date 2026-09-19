import type { UIMessage } from 'ai'
import { ChatConfigError } from './errors'

export type ModelParams = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
}

export type SkillRef = {
  id: string
  source: 'vault' | 'workspace'
}

export interface ThreadConfig {
  providerId: string
  modelId?: string
  systemInstruction: string
  params: ModelParams
  maxSteps: number
  providerOptions?: Record<string, unknown>
  enabledSkills: SkillRef[]
}

export interface ChatThread {
  id: string
  title: string
  messages: UIMessage[]
  config: ThreadConfig
  createdAt: number
  updatedAt: number
}

export const DEFAULT_MAX_STEPS = 6
export const MIN_MAX_STEPS = 4

export function defaultThreadConfig(providerId: string, modelId?: string): ThreadConfig {
  return {
    providerId,
    modelId,
    systemInstruction: '',
    params: {},
    maxSteps: DEFAULT_MAX_STEPS,
    enabledSkills: [],
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasForbiddenKey(value: Record<string, unknown>): boolean {
  return ['__proto__', 'constructor', 'prototype'].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  )
}

function assertOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChatConfigError(`${field} must be a finite number.`)
  }
  if (value < min || value > max) {
    throw new ChatConfigError(`${field} must be between ${min} and ${max}.`)
  }
}

function assertOptionalPositiveInteger(value: unknown, field: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ChatConfigError(`${field} must be a positive integer.`)
  }
}

function validateSkillRefs(value: unknown): SkillRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ChatConfigError('enabledSkills must be an array.')
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new ChatConfigError('A skill reference must be an object.')
    const id = entry.id
    const source = entry.source
    if (typeof id !== 'string' || id.length === 0) {
      throw new ChatConfigError('A skill reference needs a non-empty id.')
    }
    if (source !== 'vault' && source !== 'workspace') {
      throw new ChatConfigError(`Unknown skill source for "${id}".`)
    }
    return { id, source }
  })
}

export function validateThreadConfig(value: unknown): ThreadConfig {
  if (!isPlainObject(value)) throw new ChatConfigError('The thread config must be an object.')
  if (hasForbiddenKey(value)) throw new ChatConfigError('The thread config has an unsafe key.')

  const providerId = value.providerId
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new ChatConfigError('providerId must be a non-empty string.')
  }
  const modelId = value.modelId
  if (modelId !== undefined && typeof modelId !== 'string') {
    throw new ChatConfigError('modelId must be a string when present.')
  }
  const systemInstruction = value.systemInstruction ?? ''
  if (typeof systemInstruction !== 'string') {
    throw new ChatConfigError('systemInstruction must be a string.')
  }

  const params = value.params ?? {}
  if (!isPlainObject(params)) throw new ChatConfigError('params must be a plain object.')
  if (hasForbiddenKey(params)) throw new ChatConfigError('params has an unsafe key.')
  assertOptionalNumber(params.temperature, 'temperature', 0, 2)
  assertOptionalNumber(params.topP, 'topP', 0, 1)
  assertOptionalPositiveInteger(params.topK, 'topK')
  assertOptionalPositiveInteger(params.maxOutputTokens, 'maxOutputTokens')

  const maxSteps = value.maxSteps
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < MIN_MAX_STEPS) {
    throw new ChatConfigError(`maxSteps must be an integer >= ${MIN_MAX_STEPS}.`)
  }

  const providerOptions = value.providerOptions
  if (providerOptions !== undefined) {
    if (!isPlainObject(providerOptions)) {
      throw new ChatConfigError('providerOptions must be a plain object when present.')
    }
    if (hasForbiddenKey(providerOptions)) {
      throw new ChatConfigError('providerOptions has an unsafe key.')
    }
  }

  const enabledSkills = validateSkillRefs(value.enabledSkills)

  const validated: ThreadConfig = {
    providerId,
    systemInstruction,
    params: {
      ...(params.temperature !== undefined ? { temperature: params.temperature as number } : {}),
      ...(params.topP !== undefined ? { topP: params.topP as number } : {}),
      ...(params.topK !== undefined ? { topK: params.topK as number } : {}),
      ...(params.maxOutputTokens !== undefined
        ? { maxOutputTokens: params.maxOutputTokens as number }
        : {}),
    },
    maxSteps,
    enabledSkills,
  }
  if (modelId !== undefined) validated.modelId = modelId
  if (providerOptions !== undefined) validated.providerOptions = providerOptions
  return validated
}
