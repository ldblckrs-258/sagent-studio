import type { ToolResultCode } from "@/tools/result";

/**
 * Presentation-only view of the `ToolResult` envelope that every built-in tool
 * returns. These helpers never write back into a message part: the tool views
 * read `args`/`result` and render them, so the model-visible content of a turn
 * is byte-for-byte unchanged by anything in this folder.
 */
export interface ToolEnvelope {
  ok: boolean;
  code: ToolResultCode | string;
  value?: unknown;
  message?: string;
  hint?: string;
  truncated?: boolean;
}

/**
 * Normalizes the runtime's `result` into the envelope shape. Three cases reach
 * here: a `ToolResult` object, a bare string (the runtime's error text on a
 * failed call), and arbitrary JSON from a user tool.
 */
export function readEnvelope(result: unknown): ToolEnvelope | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") {
    return { ok: false, code: "runtime_error", message: result };
  }
  if (typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.ok === "boolean") return record as unknown as ToolEnvelope;
    return { ok: true, code: "ok", value: result };
  }
  return { ok: true, code: "ok", value: result };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Last path segment, for a header that reads "Read <file>" not "Read <dir/file>". */
export function basename(path: string | undefined): string {
  if (!path) return "workspace root";
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length > 0 ? name : trimmed;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** A revision hash is long; ten characters are plenty to compare by eye. */
export function shortHash(hash: unknown): string | undefined {
  if (typeof hash !== "string" || hash.length === 0) return undefined;
  return hash.length > 10 ? hash.slice(0, 10) : hash;
}

export function formatClock(time: number | undefined): string | undefined {
  if (time === undefined || !Number.isFinite(time)) return undefined;
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Turns an ISO timestamp or epoch millisecond value into a short clock time. */
export function formatTimestamp(time: unknown): string | undefined {
  if (typeof time === "number") return formatClock(time);
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) return formatClock(parsed);
  }
  return undefined;
}

export function formatAge(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = ms / 1000;
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `before_hash` reads as "before hash" in a definition list. */
export function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, " ").trim();
}

const CODE_LABELS: Record<string, string> = {
  ok: "Done",
  invalid_input: "Invalid input",
  path_rejected: "Path rejected",
  permission_denied: "Permission denied",
  not_found: "Not found",
  limit_exceeded: "Limit exceeded",
  no_match: "No match",
  multiple_matches: "Multiple matches",
  stale_write: "Stale write",
  conflict: "Conflict",
  approval_required: "Approval required",
  denied: "Denied",
  timeout: "Timed out",
  disabled: "Unavailable",
  http_error: "Request failed",
  runtime_error: "Failed",
};

export function humanizeCode(code: string | undefined): string {
  if (!code) return "Failed";
  return CODE_LABELS[code] ?? humanizeKey(code);
}

/** Caps a block before it hits the DOM; the footer reports what was hidden. */
export function capLines(
  text: string,
  limit: number,
): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { text, hidden: 0 };
  return { text: lines.slice(0, limit).join("\n"), hidden: lines.length - limit };
}

export function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json !== undefined) return json;
  } catch {
    // Conflict-free fallthrough below.
  }
  try {
    return String(value);
  } catch {
    return "[unserializable value]";
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
