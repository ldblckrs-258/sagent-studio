import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, EmbeddingModelUsage } from "ai";
import { embedMany, APICallError } from "ai";
import { encode } from "gpt-tokenizer";
import type { Settings } from "../vault/settings";
import { modelCapsFor } from "./model-caps";
import { LLMConfigError, resolveProvider } from "./providers";

export class EmbeddingProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingProbeError";
  }
}

/**
 * Extracts the provider's response body from an AI SDK error, so a rejected
 * embedding request reports *why*. The SDK puts the parsed body on
 * `responseBody`/`data`; a plain error falls back to its message.
 */
export function providerErrorDetail(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const responseBody = (cause as { responseBody?: unknown }).responseBody;
    if (typeof responseBody === "string" && responseBody.trim()) {
      return responseBody.trim().slice(0, 300);
    }
    const data = (cause as { data?: unknown }).data;
    if (data !== undefined) {
      try {
        return JSON.stringify(data).slice(0, 300);
      } catch {
        // fall through to the message
      }
    }
  }
  if (cause instanceof Error) return cause.message;
  return cause === undefined ? "" : String(cause);
}

/**
 * Builds an embedding model from the configured provider. `providerId` is the
 * provider the user picked in the Documents panel; the fallback to
 * `rag.embedProviderId`, then the first configured provider, only seeds that
 * control before the first explicit pick — it is never a silent selection.
 */
export function createEmbedder(
  settings: Settings,
  providerId?: string,
): EmbeddingModel {
  const id =
    providerId ??
    settings.rag.embedProviderId ??
    settings.providers[0]?.id ??
    "";
  const provider = resolveProvider(settings.providers, id);
  const modelId = settings.rag.embedModel.trim();
  if (!modelId) throw new LLMConfigError("An embedding model id is required.");
  const compatible = createOpenAICompatible({
    baseURL: provider.baseURL,
    name: provider.id,
    apiKey: provider.apiKey,
  });
  return compatible.embeddingModel(modelId);
}

export interface ProbeOptions {
  /** Named in the failure message so the user knows which provider to fix. */
  providerId?: string;
  modelId?: string;
  signal?: AbortSignal;
}

/**
 * One-item `embedMany` probe. Runs before the first ingest of a run so a
 * provider that serves no embedding model fails with a named, actionable error
 * instead of writing rows. Returns the vector's dimension.
 */
export async function probeEmbedding(
  model: EmbeddingModel,
  options: ProbeOptions = {},
): Promise<number> {
  const { providerId, modelId, signal } = options;
  let embeddings: number[][];
  try {
    const result = await embedMany({
      model,
      values: ["ping"],
      maxRetries: 0,
      abortSignal: signal,
    });
    embeddings = result.embeddings;
  } catch (cause) {
    const detail = providerErrorDetail(cause);
    throw new EmbeddingProbeError(
      `The embedding provider${providerId ? ` "${providerId}"` : ""} did not return an embedding for model "${
        modelId ?? "the configured model"
      }". Check that the provider is an OpenAI-compatible endpoint that serves an embedding model, and confirm the provider and model in the Documents panel.${detail ? ` Provider said: ${detail}` : ""}`,
      { cause },
    );
  }
  const first = embeddings[0];
  if (!first || first.length === 0) {
    throw new EmbeddingProbeError(
      `The embedding provider${providerId ? ` "${providerId}"` : ""} returned no vector for model "${
        modelId ?? "the configured model"
      }". Configure an embedding model for this provider.`,
    );
  }
  return first.length;
}

export class EmbeddingInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingInputError";
  }
}

/**
 * A hard ceiling on one embedding input. The chunker already clamps to
 * `MAX_CHUNK_TOKENS`, so a value over this bound means chunking was bypassed;
 * catching it here turns a provider `invalid request error` (which reports zero
 * tokens and no reason) into an actionable client error.
 */
export const MAX_EMBED_INPUT_TOKENS = 1024;

/**
 * A per-request ceiling used when the embedding model reports no window. The
 * SDK only auto-splits against `maxEmbeddingsPerCall` (the openai-compatible
 * default is 2048), so without an explicit budget a large document becomes one
 * request and a provider with a per-request token cap rejects it.
 */
export const DEFAULT_MAX_EMBED_REQUEST_TOKENS = 8192;

/**
 * An upper bound on passages in one request. Kept deliberately low: providers
 * often cap requests below their advertised window, and every rejected request
 * both wastes a call and counts against a per-minute rate limit. A batch that
 * is still too large for a given provider is discovered once, then remembered
 * in `learnedLimits` so later runs start at the working size.
 */
export const MAX_EMBED_INPUTS_PER_CALL = 8;

/**
 * The working batch size/token budget learned for a model after a provider
 * rejects a larger request. In-memory only; a reload re-learns at most once.
 */
const learnedLimits = new Map<string, { maxInputs: number; budget: number }>();

function modelKey(model: EmbeddingModel): string {
  return typeof model === "string" ? `id:${model}` : `${model.provider}:${model.modelId}`;
}

/**
 * HTTP statuses a provider uses when a request is larger than it accepts. A
 * batch that returns one of these is retried in smaller pieces rather than
 * failed, because the provider's real cap can sit below its advertised window.
 */
const BATCH_TOO_LARGE_STATUSES = new Set([400, 413, 422]);

function isBatchTooLarge(cause: unknown): boolean {
  return (
    APICallError.isInstance(cause) &&
    cause.statusCode !== undefined &&
    BATCH_TOO_LARGE_STATUSES.has(cause.statusCode)
  );
}

/**
 * Surfaces the provider's response body in the error message. The SDK often
 * keeps the reason (e.g. "maximum context length is ...") on `responseBody`, so
 * without this the UI only shows a bare "Bad Request".
 */
function withProviderDetail(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const detail = providerErrorDetail(cause);
  if (!detail || cause.message.includes(detail)) return cause;
  return new Error(`${cause.message} Provider said: ${detail}`, { cause });
}

/**
 * Retries for a rate-limited (429) or transiently failing request before the
 * error is surfaced. The SDK's own retry is disabled so a 429 can wait on the
 * provider's reset header instead of its fixed backoff.
 */
export const MAX_EMBED_RETRIES = 5;

/** A single wait never exceeds this, so a bogus reset header cannot hang ingest. */
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses an OpenAI-style rate-limit reset value. Providers send either bare
 * seconds (`"30"`) or a duration (`"1s"`, `"1m30s"`, `"500ms"`). Returns
 * milliseconds, or undefined when the value is not a duration.
 */
export function parseRateLimitDelayMs(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1_000;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    matched = true;
    total += Number(match[1]) * (DURATION_UNITS_MS[match[2]] ?? 0);
  }
  return matched ? total : undefined;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function isRateLimited(cause: unknown): boolean {
  return APICallError.isInstance(cause) && cause.statusCode === 429;
}

/**
 * How long to wait before retrying a 429. Prefers the reset headers OpenAI-style
 * endpoints send, then `retry-after`; falls back to exponential backoff when the
 * provider reports nothing.
 */
export function rateLimitDelayMs(cause: unknown, attempt: number): number {
  if (APICallError.isInstance(cause)) {
    const headers = cause.responseHeaders;
    for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
      const raw = headerValue(headers, name);
      const parsed = raw ? parseRateLimitDelayMs(raw) : undefined;
      if (parsed !== undefined) return Math.min(parsed, MAX_RATE_LIMIT_WAIT_MS);
    }
    const retryAfterMs = headerValue(headers, "retry-after-ms");
    if (retryAfterMs !== undefined) {
      const ms = Number(retryAfterMs);
      if (!Number.isNaN(ms)) return Math.min(Math.max(0, ms), MAX_RATE_LIMIT_WAIT_MS);
    }
    const retryAfter = headerValue(headers, "retry-after");
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds)) return Math.min(Math.max(0, seconds * 1_000), MAX_RATE_LIMIT_WAIT_MS);
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RATE_LIMIT_WAIT_MS);
    }
  }
  return Math.min(2_000 * 2 ** (attempt - 1), MAX_RATE_LIMIT_WAIT_MS);
}

/** Waits `ms`, rejecting early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The token budget for one embedding request. The embedding model's configured
 * context window is its per-call token cap, so it is used as-is; a model that
 * reports none falls back to `DEFAULT_MAX_EMBED_REQUEST_TOKENS`. The budget is
 * only an opening estimate: a provider whose real cap is lower returns a
 * batch-too-large status and `embedPassages` backs the request off.
 */
export function embedTokenBudget(
  settings: Settings,
  providerId: string | undefined,
  modelId: string | undefined,
): number {
  const window = modelCapsFor(settings, providerId, modelId)?.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return DEFAULT_MAX_EMBED_REQUEST_TOKENS;
  }
  return Math.max(1, Math.floor(window));
}

export interface EmbedPassagesOptions {
  maxParallelCalls?: number;
  maxTokensPerCall?: number;
  /** Called after each request with the cumulative passages embedded so far. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Thin `embedMany` wrapper that keeps each request under `maxTokensPerCall`.
 * Values are validated first (non-empty, within `MAX_EMBED_INPUT_TOKENS`), then
 * packed greedily into batches whose token totals stay in budget and sent
 * sequentially. `embeddings` is `number[][]` in input order and `usage` carries
 * tokens only — there is no dimension on a usage object, so callers take
 * dimensions from `embeddings[0].length`.
 */
export async function embedPassages(
  model: EmbeddingModel,
  texts: readonly string[],
  options: EmbedPassagesOptions = {},
): Promise<{ embeddings: number[][]; usage: EmbeddingModelUsage }> {
  if (texts.length === 0) return { embeddings: [], usage: { tokens: 0 } };

  const tokenCounts: number[] = [];
  for (const text of texts) {
    if (text.trim() === "") {
      throw new EmbeddingInputError("An empty passage cannot be embedded.");
    }
    const tokens = encode(text).length;
    if (tokens > MAX_EMBED_INPUT_TOKENS) {
      throw new EmbeddingInputError(
        "A passage of " +
          tokens +
          " tokens exceeds the " +
          MAX_EMBED_INPUT_TOKENS +
          "-token embedding input limit; the document was not chunked. Re-add it so the chunker splits it first.",
      );
    }
    tokenCounts.push(tokens);
  }

  const key = modelKey(model);
  const learned = learnedLimits.get(key);
  let budget =
    options.maxTokensPerCall !== undefined && options.maxTokensPerCall > 0
      ? Math.max(1, Math.floor(options.maxTokensPerCall))
      : DEFAULT_MAX_EMBED_REQUEST_TOKENS;
  let maxInputs = MAX_EMBED_INPUTS_PER_CALL;
  if (learned) {
    budget = Math.min(budget, learned.budget);
    maxInputs = Math.min(maxInputs, learned.maxInputs);
  }

  const embeddings: number[][] = [];
  let tokens = 0;
  let index = 0;
  let retries = 0;
  while (index < texts.length) {
    const batch: string[] = [];
    let batchTokens = 0;
    while (index < texts.length) {
      const nextTokens = tokenCounts[index];
      if (
        batch.length > 0 &&
        (batch.length >= maxInputs || batchTokens + nextTokens > budget)
      ) {
        break;
      }
      batch.push(texts[index]);
      batchTokens += nextTokens;
      index += 1;
    }

    try {
      const result = await embedMany({
        model,
        values: batch,
        // Retries are owned here so a 429 can wait on the provider's reset
        // header instead of the SDK's fixed `retry-after`/exponential default.
        maxRetries: 0,
        ...(options.maxParallelCalls !== undefined
          ? { maxParallelCalls: options.maxParallelCalls }
          : {}),
        abortSignal: options.signal,
      });
      embeddings.push(...result.embeddings);
      tokens += result.usage.tokens ?? 0;
      retries = 0;
      options.onProgress?.(embeddings.length, texts.length);
    } catch (cause) {
      // A 429 is not a size problem: wait out the provider's reset window and
      // retry the same batch, never shrinking it.
      if (isRateLimited(cause)) {
        if (retries >= MAX_EMBED_RETRIES) throw withProviderDetail(cause);
        retries += 1;
        await sleep(rateLimitDelayMs(cause, retries), options.signal);
        index -= batch.length;
        continue;
      }
      // Any other retryable (e.g. 5xx) request gets exponential backoff, since
      // the SDK's own retry is disabled above.
      if (APICallError.isInstance(cause) && cause.isRetryable) {
        if (retries >= MAX_EMBED_RETRIES) throw withProviderDetail(cause);
        retries += 1;
        await sleep(Math.min(2_000 * 2 ** (retries - 1), MAX_RATE_LIMIT_WAIT_MS), options.signal);
        index -= batch.length;
        continue;
      }
      // A provider whose real cap sits below its advertised window rejects the
      // whole request. Shrink both limits and retry the same passages instead
      // of failing; `maxInputs` strictly decreases, so this always terminates.
      if (batch.length > 1 && isBatchTooLarge(cause)) {
        budget = Math.max(1, Math.floor(budget / 2));
        maxInputs = Math.max(1, Math.min(Math.floor(maxInputs / 2), batch.length - 1));
        learnedLimits.set(key, { maxInputs, budget });
        index -= batch.length;
        continue;
      }
      throw withProviderDetail(cause);
    }
  }
  return { embeddings, usage: { tokens } };
}
