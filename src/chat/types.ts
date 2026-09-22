import type { UIMessage } from "ai";
import type { ModelTier } from "../vault/settings";
import { ChatConfigError } from "./errors";

export type ModelParams = {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
};

export type SkillRef = {
  id: string;
  source: "vault" | "workspace";
};

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanItemStatus;
}

export const MAX_PLAN_ITEMS = 50;
export const MAX_PLAN_TEXT_LENGTH = 500;

export type ChatMode = "read_only" | "editing" | "god";

export type AgentRunStatus =
  | "running"
  | "completed"
  | "denied"
  | "aborted"
  | "error"
  | "interrupted"
  | "limit_exceeded"
  | "invalid_input";

/**
 * A thread that records a delegated agent run. Present only on child agent
 * threads, which are excluded from the conversations list and shown in the
 * Agents panel instead.
 */
export interface AgentThreadMeta {
  runId: string;
  parentThreadId: string;
  label?: string;
  mode: ChatMode;
  tier: ModelTier;
  status: AgentRunStatus;
}

/**
 * A settled background run's report, carried on its notice message. The notice
 * text stays the model-visible framing; this is the structured form the
 * transcript renders as a sub-agent card instead of a bare assistant line.
 */
export interface AgentNoticeReport {
  label?: string;
  status: AgentRunStatus;
  /** The run's result summary, rendered as the report body. */
  response: string;
}

export type AgentNoticeMeta = AgentNoticeReport & { runId?: string };

const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  "running",
  "completed",
  "denied",
  "aborted",
  "error",
  "interrupted",
  "limit_exceeded",
  "invalid_input",
];

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    typeof value === "string" &&
    (AGENT_RUN_STATUSES as readonly string[]).includes(value)
  );
}

export const DEFAULT_CHAT_MODE: ChatMode = "editing";

export function isChatMode(value: unknown): value is ChatMode {
  return value === "read_only" || value === "editing" || value === "god";
}

export interface ThreadConfig {
  providerId: string;
  modelId?: string;
  systemInstruction: string;
  params: ModelParams;
  providerOptions?: Record<string, unknown>;
  enabledSkills: SkillRef[];
  /** Overrides the global context cap for this conversation's model. */
  maxContextTokens?: number;
}

export interface ChatThread {
  id: string;
  title: string;
  /**
   * How the title was set: `auto` by the naming task, `user` by a manual
   * rename. Absent (an older thread, or one still titled "New chat") is treated
   * as auto-namable. A `user` title is never overwritten by the naming task.
   */
  titleSource?: "auto" | "user";
  /**
   * User-message count at the last auto-naming. The naming task re-runs every
   * fifth user message; this marker keeps a non-user run (a rerun, an approval
   * resume) from re-naming the same turn twice.
   */
  titleUserCount?: number;
  messages: UIMessage[];
  config: ThreadConfig;
  createdAt: number;
  updatedAt: number;
  /** Snapshot of the workspace folder name at creation, for list grouping. */
  workspaceName?: string;
  /** Conversation-scoped permission ceiling; absent reads as `editing`. */
  mode?: ChatMode;
  /** Thread-scoped todo list written by `update_plan`. */
  plan?: PlanItem[];
  /**
   * Present only on a delegated run's child thread. Its presence excludes the
   * thread from the conversations list.
   */
  agent?: AgentThreadMeta;
}

export function defaultThreadConfig(
  providerId: string,
  modelId?: string,
): ThreadConfig {
  return {
    providerId,
    modelId,
    systemInstruction: "",
    params: {},
    enabledSkills: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenKey(value: Record<string, unknown>): boolean {
  return ["__proto__", "constructor", "prototype"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function assertOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ChatConfigError(`${field} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new ChatConfigError(`${field} must be between ${min} and ${max}.`);
  }
}

function assertOptionalPositiveInteger(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ChatConfigError(`${field} must be a positive integer.`);
  }
}

function validateSkillRefs(value: unknown): SkillRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ChatConfigError("enabledSkills must be an array.");
  return value.map((entry) => {
    if (!isPlainObject(entry))
      throw new ChatConfigError("A skill reference must be an object.");
    const id = entry.id;
    const source = entry.source;
    if (typeof id !== "string" || id.length === 0) {
      throw new ChatConfigError("A skill reference needs a non-empty id.");
    }
    if (source !== "vault" && source !== "workspace") {
      throw new ChatConfigError(`Unknown skill source for "${id}".`);
    }
    return { id, source };
  });
}

export function validateThreadConfig(value: unknown): ThreadConfig {
  if (!isPlainObject(value))
    throw new ChatConfigError("The thread config must be an object.");
  if (hasForbiddenKey(value))
    throw new ChatConfigError("The thread config has an unsafe key.");

  const providerId = value.providerId;
  if (typeof providerId !== "string" || providerId.trim().length === 0) {
    throw new ChatConfigError("providerId must be a non-empty string.");
  }
  const modelId = value.modelId;
  if (modelId !== undefined && typeof modelId !== "string") {
    throw new ChatConfigError("modelId must be a string when present.");
  }
  const systemInstruction = value.systemInstruction ?? "";
  if (typeof systemInstruction !== "string") {
    throw new ChatConfigError("systemInstruction must be a string.");
  }

  const params = value.params ?? {};
  if (!isPlainObject(params))
    throw new ChatConfigError("params must be a plain object.");
  if (hasForbiddenKey(params))
    throw new ChatConfigError("params has an unsafe key.");
  assertOptionalNumber(params.temperature, "temperature", 0, 2);
  assertOptionalNumber(params.topP, "topP", 0, 1);
  assertOptionalPositiveInteger(params.topK, "topK");
  assertOptionalPositiveInteger(params.maxOutputTokens, "maxOutputTokens");

  const providerOptions = value.providerOptions;
  if (providerOptions !== undefined) {
    if (!isPlainObject(providerOptions)) {
      throw new ChatConfigError(
        "providerOptions must be a plain object when present.",
      );
    }
    if (hasForbiddenKey(providerOptions)) {
      throw new ChatConfigError("providerOptions has an unsafe key.");
    }
  }

  const enabledSkills = validateSkillRefs(value.enabledSkills);
  assertOptionalPositiveInteger(value.maxContextTokens, "maxContextTokens");

  const validated: ThreadConfig = {
    providerId,
    systemInstruction,
    params: {
      ...(params.temperature !== undefined
        ? { temperature: params.temperature as number }
        : {}),
      ...(params.topP !== undefined ? { topP: params.topP as number } : {}),
      ...(params.topK !== undefined ? { topK: params.topK as number } : {}),
      ...(params.maxOutputTokens !== undefined
        ? { maxOutputTokens: params.maxOutputTokens as number }
        : {}),
    },
    enabledSkills,
  };
  if (modelId !== undefined) validated.modelId = modelId;
  if (providerOptions !== undefined)
    validated.providerOptions = providerOptions;
  if (value.maxContextTokens !== undefined)
    validated.maxContextTokens = value.maxContextTokens as number;
  return validated;
}
