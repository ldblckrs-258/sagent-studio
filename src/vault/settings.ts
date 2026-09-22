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

/**
 * A capability tier for delegated and auxiliary work. Ordered from cheapest to
 * most capable: `cheap` names conversations and rewrites user-sourced RAG
 * queries, `medium` and `high` back delegated agents, and `max` is reserved for
 * explicit advisory or planning delegations.
 */
export type ModelTier = "cheap" | "medium" | "high" | "max";

export const MODEL_TIERS: readonly ModelTier[] = [
  "cheap",
  "medium",
  "high",
  "max",
];

/**
 * One tier's model selection. Optional and absent by default: a tier with no
 * provider resolves to no model, and the caller falls back to the
 * conversation's own model, so the features work unconfigured.
 */
export interface TierModelSettings {
  /** Provider of the tier's model. Absent means "not configured". */
  providerId?: string;
  /** Model id; absent uses the provider's `defaultModel`. */
  modelId?: string;
}

export type TierModelsSettings = Partial<Record<ModelTier, TierModelSettings>>;

/**
 * The provider/model the user last chose, so a new conversation opens on it
 * instead of the first configured provider. Optional and absent by default;
 * a selection whose provider no longer resolves is ignored.
 */
export interface LastModelSettings {
  providerId?: string;
  modelId?: string;
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
   * The per-tier model selections for delegated and auxiliary work; absent
   * means "not configured".
   */
  modelTiers?: TierModelsSettings;
  /** The last model the user chose; absent means "no preference yet". */
  lastModel?: LastModelSettings;
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

/**
 * Keeps only string, non-empty, trimmed `providerId`/`modelId` fields so a
 * hand-edited vault cannot smuggle a non-string past `createLLM`. Returns
 * `undefined` when nothing usable is left, matching "not configured".
 */
export function normalizeTierModel(value: unknown): TierModelSettings | undefined {
  if (!isPlainObject(value)) return undefined;
  const providerId =
    typeof value.providerId === "string" ? value.providerId.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (providerId === "" && modelId === "") return undefined;
  const tier: TierModelSettings = {};
  if (providerId !== "") tier.providerId = providerId;
  if (modelId !== "") tier.modelId = modelId;
  return tier;
}

/**
 * Normalizes a tier map to the four known tiers, dropping unknown keys and
 * malformed selections. Returns `undefined` when nothing usable survives, which
 * keeps `Settings.modelTiers` absent rather than an empty object.
 */
export function normalizeTierModels(value: unknown): TierModelsSettings | undefined {
  if (!isPlainObject(value)) return undefined;
  const tiers: TierModelsSettings = {};
  for (const tier of MODEL_TIERS) {
    const normalized = normalizeTierModel(value[tier]);
    if (normalized) tiers[tier] = normalized;
  }
  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

/** Normalizes the last-used selection; same field hygiene as a tier selection. */
export function normalizeLastModel(value: unknown): LastModelSettings | undefined {
  return normalizeTierModel(value);
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
  // A vault written before tiers existed stored a single `subModel`; it becomes
  // the cheap tier without overwriting an explicit cheap selection. Both raw
  // keys are destructured out so neither survives into `rest`.
  // `subModel` is a legacy key absent from the current `Settings` shape but still
  // present at runtime after `deepMerge`, so it is destructured through an
  // intersection to strip it without a type error.
  const {
    subModel: rawSubModel,
    modelTiers: rawModelTiers,
    lastModel: rawLastModel,
    ...rest
  } = merged as typeof merged & {
    subModel?: unknown;
    lastModel?: unknown;
  };
  let tiers = normalizeTierModels(rawModelTiers);
  if (tiers?.cheap === undefined) {
    const legacyCheap = normalizeTierModel(rawSubModel);
    if (legacyCheap) {
      tiers = { ...tiers, cheap: legacyCheap };
    }
  }
  const lastModel = normalizeLastModel(rawLastModel);
  return {
    ...rest,
    providers: normalizeProviders(merged.providers),
    context,
    ...(tiers ? { modelTiers: tiers } : {}),
    ...(lastModel ? { lastModel } : {}),
  };
}
