import { VaultMigrationError } from "./errors";

export const SETTINGS_VERSION = 1;

/**
 * What a model can do and how large its window is. Every field is optional:
 * a hand-typed model has no metadata, and a field the provider did not report
 * stays unknown rather than being guessed. `model-caps.ts` owns the fallbacks.
 */
export interface ModelCaps {
  vision?: boolean;
  search?: boolean;
  reasoning?: boolean;
  /** Usable as an embedding model; drives the Documents panel's model picker. */
  embedding?: boolean;
  contextWindow?: number;
  maxOutput?: number;
}

export interface ModelConfig {
  /** The id sent to the provider's chat endpoint. */
  id: string;
  /** A display label when the provider reports one distinct from the id. */
  name?: string;
  caps?: ModelCaps;
}

export interface ProviderConfig {
  id: string;
  label: string;
  kind: "openai-compatible";
  baseURL: string;
  apiKey: string;
  models: ModelConfig[];
  defaultModel: string;
}

export interface TypeSafeSettings {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface RagSettings {
  embedModel: string;
  /**
   * The provider the user picked for embeddings. An absent value only seeds the
   * Documents panel control with the first configured provider before the first
   * explicit pick; it is never a silent selection.
   */
  embedProviderId?: string;
  /** Chunk size in tokens, clamped to [64, 1024] by the chunker. */
  chunkSize: number;
  /** Overlap in tokens, about 15% of `chunkSize` by default. */
  overlap: number;
  topK: number;
  thresholds: Record<string, number>;
  concurrency: number;
}

/**
 * Structural mirror of the chat layer's `SkillRef`, declared locally so the
 * vault layer imports nothing from `src/chat`.
 */
export interface PersistedSkillRef {
  id: string;
  source: "vault" | "workspace";
}

export interface SandboxSettings {
  enabled: boolean;
  jsTimeoutMs: number;
  pyTimeoutMs: number;
  idleTimeoutMs: number;
}

/**
 * The context window the chat measures itself against. A model that reports a
 * `caps.contextWindow` supplies the window; this `maxContextTokens` is the
 * fallback for a model with no metadata, and a per-thread override still wins.
 */
export interface ContextSettings {
  maxContextTokens: number;
  autoCompactRatio: number;
  autoCompactEnabled: boolean;
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
export const DEFAULT_AUTO_COMPACT_RATIO = 0.9;
/**
 * The ratio shipped before per-model windows existed. A vault still holding the
 * exact old default is treated as unset and upgraded once, because the value
 * had no UI and so was never a deliberate choice.
 */
export const LEGACY_AUTO_COMPACT_RATIO = 0.8;
export const MIN_AUTO_COMPACT_RATIO = 0.1;
export const MAX_AUTO_COMPACT_RATIO = 0.95;

export type ApprovalDecision = "allow" | "ask" | "deny";

export interface ApprovalSettings {
  tools: Record<string, ApprovalDecision>;
}

export const DEFAULT_APPROVAL_DECISION: ApprovalDecision = "ask";

// Kept in sync with the runner constants by a unit test, without importing
// app-local sandbox modules into the vault layer.
export const DEFAULT_SANDBOX_JS_TIMEOUT_MS = 10_000;
export const DEFAULT_SANDBOX_PY_TIMEOUT_MS = 30_000;
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 300_000;

export interface Settings {
  version: number;
  providers: ProviderConfig[];
  typesafe: TypeSafeSettings;
  rag: RagSettings;
  sandbox: SandboxSettings;
  approvals: ApprovalSettings;
  context: ContextSettings;
  egressNoticeDismissed: boolean;
  idleLockMinutes: number;
  /**
   * Optional and deliberately absent by default: an absent policy means
   * "enable every vault skill", so existing vaults keep working. Adding it to
   * `defaultSettings()` would stamp an empty policy and disable every skill.
   */
  skills?: { enabled?: PersistedSkillRef[] };
}

export const MAX_PROVIDERS = 20;
export const MAX_MODELS_PER_PROVIDER = 500;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    providers: [],
    typesafe: { apiKey: "", model: "jev-latest" },
    rag: {
      embedModel: "text-embedding-3-small",
      chunkSize: 400,
      overlap: 60,
      topK: 5,
      thresholds: {},
      concurrency: 4,
    },
    sandbox: {
      enabled: true,
      jsTimeoutMs: DEFAULT_SANDBOX_JS_TIMEOUT_MS,
      pyTimeoutMs: DEFAULT_SANDBOX_PY_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    },
    approvals: { tools: {} },
    context: {
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      autoCompactRatio: DEFAULT_AUTO_COMPACT_RATIO,
      autoCompactEnabled: true,
    },
    egressNoticeDismissed: false,
    idleLockMinutes: 15,
  };
}

/**
 * Checks a context block and reports the first problem in the message. Throwing
 * is what `migrate` catches to fall back to the defaults, so a vault written by
 * hand stays loadable while a bad value never reaches the cap arithmetic.
 */
export function validateContextSettings(value: unknown): ContextSettings {
  if (!isPlainObject(value)) {
    throw new VaultMigrationError("The context settings must be an object.");
  }
  const maxContextTokens = value.maxContextTokens;
  if (
    typeof maxContextTokens !== "number" ||
    !Number.isInteger(maxContextTokens) ||
    maxContextTokens <= 0
  ) {
    throw new VaultMigrationError(
      "maxContextTokens must be a positive integer.",
    );
  }
  const autoCompactRatio = value.autoCompactRatio;
  if (
    typeof autoCompactRatio !== "number" ||
    !Number.isFinite(autoCompactRatio) ||
    autoCompactRatio < MIN_AUTO_COMPACT_RATIO ||
    autoCompactRatio > MAX_AUTO_COMPACT_RATIO
  ) {
    throw new VaultMigrationError(
      `autoCompactRatio must be between ${MIN_AUTO_COMPACT_RATIO} and ${MAX_AUTO_COMPACT_RATIO}.`,
    );
  }
  const autoCompactEnabled = value.autoCompactEnabled;
  if (typeof autoCompactEnabled !== "boolean") {
    throw new VaultMigrationError("autoCompactEnabled must be a boolean.");
  }
  return { maxContextTokens, autoCompactRatio, autoCompactEnabled };
}

type PlainObject = Record<string, unknown>;

export type DeepPartial<T> = T extends object
  ? T extends readonly unknown[]
    ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads a caps block tolerantly: a boolean field is kept only when boolean and
 * a size field only when a positive integer. Unknown or malformed fields are
 * dropped rather than repaired, so "unknown" stays distinguishable from "false"
 * and `model-caps.ts` can apply its own fallback.
 */
export function validateModelCaps(value: unknown): ModelCaps | undefined {
  if (!isPlainObject(value)) return undefined;
  const caps: ModelCaps = {};
  for (const key of ["vision", "search", "reasoning", "embedding"] as const) {
    const field = value[key];
    if (typeof field === "boolean") caps[key] = field;
  }
  for (const key of ["contextWindow", "maxOutput"] as const) {
    const field = value[key];
    if (typeof field === "number" && Number.isInteger(field) && field > 0) {
      caps[key] = field;
    }
  }
  return Object.keys(caps).length > 0 ? caps : undefined;
}

function normalizeModel(value: unknown): ModelConfig | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id === "" ? null : { id };
  }
  if (!isPlainObject(value)) return null;
  const rawId = value.id ?? value.model;
  if (typeof rawId !== "string" || rawId.trim() === "") return null;
  const id = rawId.trim();
  const model: ModelConfig = { id };
  const rawName = value.name ?? value.alias;
  if (
    typeof rawName === "string" &&
    rawName.trim() !== "" &&
    rawName.trim() !== id
  ) {
    model.name = rawName.trim();
  }
  const caps = validateModelCaps(value.caps);
  if (caps) model.caps = caps;
  return model;
}

/**
 * Repairs persisted providers after `deepMerge`, which cannot know that a
 * version of this app stored bare model ids. A string entry becomes `{ id }`
 * with no caps, an over-long list is trimmed, and a default model that no
 * longer names a listed model falls back to the first. Bad entries are dropped
 * rather than failing the whole vault open.
 */
export function normalizeProviders(value: unknown): ProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const providers: ProviderConfig[] = [];
  for (const entry of value) {
    if (providers.length >= MAX_PROVIDERS) break;
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") continue;
    const rawModels = Array.isArray(entry.models) ? entry.models : [];
    const models: ModelConfig[] = [];
    const seen = new Set<string>();
    for (const raw of rawModels) {
      if (models.length >= MAX_MODELS_PER_PROVIDER) break;
      const model = normalizeModel(raw);
      if (model === null || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    const requestedDefault =
      typeof entry.defaultModel === "string" ? entry.defaultModel : "";
    const defaultModel = models.some((model) => model.id === requestedDefault)
      ? requestedDefault
      : (models[0]?.id ?? "");
    providers.push({
      id,
      label: typeof entry.label === "string" ? entry.label : "",
      kind: "openai-compatible",
      baseURL: typeof entry.baseURL === "string" ? entry.baseURL : "",
      apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
      models,
      defaultModel,
    });
  }
  return providers;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T);
  }
  if (!isPlainObject(base)) {
    return deepMerge({} as PlainObject, patch) as T;
  }
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(current)
        ? deepMerge(current, value)
        : value;
  }
  return out as T;
}

export function migrate(version: number, data: unknown): Settings {
  if (!Number.isInteger(version) || version < 1) {
    throw new VaultMigrationError(
      `Invalid settings version: ${String(version)}`,
    );
  }
  if (version > SETTINGS_VERSION) {
    throw new VaultMigrationError(
      `Settings version ${version} is newer than this app supports (${SETTINGS_VERSION}).`,
    );
  }
  if (!isPlainObject(data)) {
    throw new VaultMigrationError("Decrypted settings were not an object.");
  }
  const merged = deepMerge(defaultSettings(), data);
  // A vault written before the context block existed merges the defaults in;
  // one carrying an out-of-range value is repaired rather than made unloadable,
  // because the cap is a preference and refusing to unlock over it would lock
  // the user out of their own keys.
  let context: ContextSettings;
  try {
    context = validateContextSettings(merged.context);
    if (context.autoCompactRatio === LEGACY_AUTO_COMPACT_RATIO) {
      context = { ...context, autoCompactRatio: DEFAULT_AUTO_COMPACT_RATIO };
    }
  } catch {
    context = defaultSettings().context;
  }
  return {
    ...merged,
    providers: normalizeProviders(merged.providers),
    context,
  };
}
