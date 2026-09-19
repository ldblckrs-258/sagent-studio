import { ChatConfigError } from "./errors";
import type { SkillRef, ThreadConfig } from "./types";
import { validateThreadConfig } from "./types";

/** The Thread tab's raw form shape: numbers and JSON are kept as text. */
export interface ConfigDraft {
  providerId: string;
  modelId: string;
  systemInstruction: string;
  temperature: string;
  topP: string;
  topK: string;
  maxOutputTokens: string;
  providerOptions: string;
  enabledSkills: SkillRef[];
}

const FIELD_KEYS = [
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "providerId",
  "providerOptions",
  "enabledSkills",
  "modelId",
  "systemInstruction",
] as const;

/**
 * Maps a `ChatConfigError` message onto a field key by its leading token. Every
 * message with no recognised prefix (a skill-ref error, a top-level shape
 * error) lands under `_form`, so a blocked save always renders something.
 */
export function fieldKeyForMessage(message: string): string {
  for (const field of FIELD_KEYS) {
    if (
      message === field ||
      message.startsWith(`${field} `) ||
      message.startsWith(`${field}.`)
    ) {
      return field;
    }
  }
  return "_form";
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  return Number(value);
}

/** Builds a candidate config object from the form draft, parsing text inputs. */
export function threadConfigPatch(draft: ConfigDraft): unknown {
  const candidate: Record<string, unknown> = {
    providerId: draft.providerId,
    systemInstruction: draft.systemInstruction,
    params: {
      ...(draft.temperature.trim() !== ""
        ? { temperature: numberOrUndefined(draft.temperature) }
        : {}),
      ...(draft.topP.trim() !== ""
        ? { topP: numberOrUndefined(draft.topP) }
        : {}),
      ...(draft.topK.trim() !== ""
        ? { topK: numberOrUndefined(draft.topK) }
        : {}),
      ...(draft.maxOutputTokens.trim() !== ""
        ? { maxOutputTokens: numberOrUndefined(draft.maxOutputTokens) }
        : {}),
    },
    enabledSkills: draft.enabledSkills,
  };

  if (draft.modelId.trim() !== "") candidate.modelId = draft.modelId;
  if (draft.providerOptions.trim() !== "") {
    try {
      candidate.providerOptions = JSON.parse(draft.providerOptions);
    } catch {
      throw new ChatConfigError("providerOptions must be valid JSON.");
    }
  }
  return candidate;
}

export interface ConfigValidationResult {
  config?: ThreadConfig;
  errors: Record<string, string>;
}

/** Validates a candidate config and reports the error under its field key. */
export function validateConfigDraft(
  candidate: unknown,
): ConfigValidationResult {
  try {
    return { config: validateThreadConfig(candidate), errors: {} };
  } catch (error) {
    if (error instanceof ChatConfigError) {
      return { errors: { [fieldKeyForMessage(error.message)]: error.message } };
    }
    throw error;
  }
}
