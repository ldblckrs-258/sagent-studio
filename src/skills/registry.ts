import type { ResolvedSkill } from '../chat/context'
import type { SkillRef } from '../chat/types'
import { SkillParseError, isSkillManifest, skillKey, skillRefOf } from './schema'
import type { SkillManifest } from './schema'
import { skillStore } from './store'

export interface SkillSource {
  list(): Promise<SkillManifest[]>
}

export interface SkillStore {
  save(manifest: SkillManifest): Promise<void>
  remove(id: string): Promise<void>
  list(): Promise<SkillManifest[]>
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillManifest>()
  private readonly enabled = new Set<string>()
  private readonly store: SkillStore

  constructor(store: SkillStore = skillStore) {
    this.store = store
  }

  register(manifest: SkillManifest, options: { enabled?: boolean } = {}): void {
    if (!isSkillManifest(manifest)) {
      throw new SkillParseError('The skill manifest is malformed.')
    }
    const key = skillKey(skillRefOf(manifest))
    this.skills.set(key, { ...manifest, allowedTools: [...manifest.allowedTools] })
    if (options.enabled) this.enabled.add(key)
  }

  get(ref: SkillRef): SkillManifest | undefined {
    return this.skills.get(skillKey(ref))
  }

  list(): SkillManifest[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  isEnabled(ref: SkillRef): boolean {
    return this.enabled.has(skillKey(ref))
  }

  setEnabled(ref: SkillRef, enabled: boolean): void {
    const key = skillKey(ref)
    if (enabled) this.enabled.add(key)
    else this.enabled.delete(key)
  }

  resolve(refs: readonly SkillRef[]): ResolvedSkill[] {
    const resolved: ResolvedSkill[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      const key = skillKey(ref)
      if (seen.has(key)) continue
      const manifest = this.skills.get(key)
      if (!manifest) continue
      if (!this.enabled.has(key)) continue
      seen.add(key)
      resolved.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        instructions: manifest.instructions,
        source: manifest.source,
        allowedTools: [...manifest.allowedTools],
      })
    }
    return resolved.sort((a, b) => a.id.localeCompare(b.id))
  }

  instructionsFor(refs: readonly SkillRef[]): string {
    return this.resolve(refs)
      .map((skill) => skill.instructions)
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
  }

  toolNamesFor(refs: readonly SkillRef[], pool: ReadonlySet<string>): string[] | undefined {
    const skills = this.resolve(refs)
    if (skills.length === 0) return undefined
    const names = new Set<string>()
    for (const skill of skills) {
      if (skill.allowedTools.length === 0) {
        for (const name of pool) names.add(name)
        continue
      }
      for (const name of skill.allowedTools) {
        if (pool.has(name)) names.add(name)
      }
    }
    return [...names].sort()
  }

  async importSkill(manifest: SkillManifest): Promise<SkillManifest> {
    const stored: SkillManifest = { ...manifest, source: 'vault', allowedTools: [...manifest.allowedTools] }
    if (!isSkillManifest(stored)) throw new SkillParseError('The skill manifest is malformed.')
    await this.store.save(stored)
    this.register(stored, { enabled: true })
    return stored
  }

  async updateSkill(manifest: SkillManifest): Promise<void> {
    if (!isSkillManifest(manifest)) throw new SkillParseError('The skill manifest is malformed.')
    const key = skillKey(skillRefOf(manifest))
    if (!this.skills.has(key)) {
      throw new SkillParseError(`No skill "${manifest.id}" (${manifest.source}) is registered.`)
    }
    await this.store.save(manifest)
    this.skills.set(key, { ...manifest, allowedTools: [...manifest.allowedTools] })
  }

  async removeSkill(ref: SkillRef): Promise<void> {
    await this.store.remove(ref.id)
    const key = skillKey(ref)
    this.skills.delete(key)
    this.enabled.delete(key)
  }

  async loadWorkspaceSkills(source: SkillSource): Promise<SkillManifest[]> {
    const manifests = await source.list()
    for (const manifest of manifests) {
      this.register({ ...manifest, source: 'workspace' }, { enabled: false })
    }
    return manifests
  }

  async hydrate(): Promise<void> {
    for (const manifest of await this.store.list()) {
      this.register(manifest, { enabled: true })
    }
  }
}
