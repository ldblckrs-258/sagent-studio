import { db } from '../vault/db'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { SkillParseError, isSkillManifest } from './schema'
import type { SkillManifest } from './schema'

export const SKILL_ENVELOPE_VERSION = 1

function parseEnvelope(raw: string): SkillManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new SkillParseError('The decrypted skill was not valid JSON.', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SkillParseError('The skill envelope was not an object.')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SkillParseError('The skill envelope version is invalid.')
  }
  if (version > SKILL_ENVELOPE_VERSION) {
    throw new SkillParseError(`Skill envelope version ${version} is newer than this app supports.`)
  }
  const skill = (parsed as { skill?: unknown }).skill
  if (!isSkillManifest(skill)) throw new SkillParseError('The stored skill manifest is malformed.')
  return skill
}

export async function saveSkill(manifest: SkillManifest): Promise<void> {
  if (!isSkillManifest(manifest)) throw new SkillParseError('The skill manifest is malformed.')
  await vaultWriteQueue.enqueue(async () => {
    const envelope = JSON.stringify({ version: SKILL_ENVELOPE_VERSION, skill: manifest })
    const blob = await encryptRecord(envelope, `skill:${manifest.id}`)
    await db.skills.put({ id: manifest.id, blob, updatedAt: Date.now() })
  })
}

export async function loadSkill(id: string): Promise<SkillManifest | null> {
  const row = await db.skills.get(id)
  if (!row) return null
  return parseEnvelope(await decryptRecord(row.blob, `skill:${id}`))
}

export async function listSkills(): Promise<SkillManifest[]> {
  const rows = await db.skills.toArray()
  const skills = await Promise.all(
    rows.map(async (row) => parseEnvelope(await decryptRecord(row.blob, `skill:${row.id}`))),
  )
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

export async function removeSkill(id: string): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    await db.skills.delete(id)
  })
}

export const skillStore = {
  save: saveSkill,
  remove: removeSkill,
  list: listSkills,
}
