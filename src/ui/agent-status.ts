import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import {
  humanizeKey,
  isPlainRecord,
  readEnvelope,
} from "../components/assistant-ui/elements/tool-view/helpers";
import { TOOL_VIEWS } from "../components/assistant-ui/elements/tool-view/registry";
import { isCompactionMessage } from "../agents/run-transcript";

export const STATUS_TINT: Record<string, string> = {
  running: "text-accent",
  completed: "text-positive",
  interrupted: "text-caution",
  denied: "text-caution",
  aborted: "text-muted",
  stopped: "text-caution",
  error: "text-danger",
  limit_exceeded: "text-danger",
  invalid_input: "text-danger",
};

export const STATUS_DOT: Record<string, string> = {
  running: "bg-accent",
  completed: "bg-positive",
  interrupted: "bg-caution",
  denied: "bg-caution",
  aborted: "bg-muted",
  stopped: "bg-caution",
  error: "bg-danger",
  limit_exceeded: "bg-danger",
  invalid_input: "bg-danger",
};

export function isRunning(status: string): boolean {
  return status === "running";
}

export function elapsed(startedAt: number, endedAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

type Part = UIMessage["parts"][number];

function humanizeToolName(toolName: string): string {
  const words = humanizeKey(toolName);
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : toolName;
}

function isRunningToolPart(part: Part): boolean {
  if (!isToolUIPart(part)) return false;
  return (
    part.state !== "output-available" &&
    part.state !== "output-error" &&
    part.state !== "output-denied"
  );
}

function toolPartLabel(part: Part): string {
  if (!isToolUIPart(part)) return "";
  const toolName = getToolName(part);
  const spec = TOOL_VIEWS[toolName];
  const args = isPlainRecord(part.input) ? part.input : {};
  if (spec) return spec.label(args, readEnvelope(part.output));
  return humanizeToolName(toolName);
}

function findRunningToolLabel(messages: readonly UIMessage[]): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      if (isRunningToolPart(parts[partIndex])) return toolPartLabel(parts[partIndex]);
    }
  }
  return undefined;
}

function lastAssistantTextLine(messages: readonly UIMessage[]): string {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant" || isCompactionMessage(message)) continue;
    const text = message.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return "";
}

export function activityOf(messages: readonly UIMessage[], status: string): string {
  if (isRunning(status)) {
    const runningLabel = findRunningToolLabel(messages);
    if (runningLabel !== undefined) return runningLabel;
  }
  return lastAssistantTextLine(messages);
}

export { toolCallCount } from "../agents/run-transcript";
