import type { UIMessage } from "ai";
import { autoCompactThreshold } from "../chat/context-cap";
import type { ResolvedContextCap } from "../chat/context-cap";
import type { LiveStreamStats } from "../chat/store";
import {
  contextTokensOf,
  estimateTokensFromChars,
  totalTokensOf,
  usageOf,
} from "../chat/usage";

/**
 * Derivation and formatting for the meter, kept pure so the numbers are
 * testable under the repository's `environment: "node"` vitest setup. This is
 * the same split `plan-view.ts` uses beside `plan-panel.tsx`.
 */

export interface MeterInput {
  messages: readonly UIMessage[];
  cap: ResolvedContextCap;
  /** Present only while a run streams into this thread. */
  liveStats?: LiveStreamStats | undefined;
  running: boolean;
  now: number;
}

export interface MeterView {
  /** False for an empty thread, so a new chat stays clean. */
  visible: boolean;
  totalTokens: number;
  contextTokens: number;
  maxContextTokens: number;
  /** Clamped to 100, because a context can exceed a misconfigured cap. */
  usedPercent: number;
  thresholdPercent: number;
  /** True once auto-compaction would fire, which tints the bar. */
  overThreshold: boolean;
  /** True when the context figure came from the character estimate. */
  estimated: boolean;
  tokensPerSecond?: number;
  rateEstimated: boolean;
}

function lastUsageOf(messages: readonly UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = usageOf(messages[index]);
    if (usage) return usage;
  }
  return undefined;
}

/**
 * The live rate is derived from streamed characters over elapsed time, so it
 * moves during a run; the exact rate replaces it at finish, computed by the
 * engine from the provider's own output count.
 */
function rateOf(input: MeterInput): {
  tokensPerSecond?: number;
  rateEstimated: boolean;
} {
  if (input.running) {
    const stats = input.liveStats;
    if (!stats) return { rateEstimated: true };
    const seconds = (input.now - stats.startedAt) / 1000;
    if (seconds <= 0) return { rateEstimated: true };
    return {
      tokensPerSecond: estimateTokensFromChars(stats.chars) / seconds,
      rateEstimated: true,
    };
  }
  const usage = lastUsageOf(input.messages);
  if (usage?.tokensPerSecond === undefined) return { rateEstimated: true };
  return {
    tokensPerSecond: usage.tokensPerSecond,
    rateEstimated: usage.estimated,
  };
}

export function meterView(input: MeterInput): MeterView {
  const context = contextTokensOf(input.messages);
  const threshold = autoCompactThreshold(input.cap);
  const { tokensPerSecond, rateEstimated } = rateOf(input);
  return {
    visible: input.messages.length > 0,
    totalTokens: totalTokensOf(input.messages),
    contextTokens: context.tokens,
    maxContextTokens: input.cap.maxContextTokens,
    usedPercent: Math.min(
      100,
      (context.tokens / input.cap.maxContextTokens) * 100,
    ),
    thresholdPercent: Math.min(
      100,
      (threshold / input.cap.maxContextTokens) * 100,
    ),
    overThreshold: input.cap.autoCompactEnabled && context.tokens >= threshold,
    estimated: context.estimated,
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    rateEstimated,
  };
}

/** Compact token counts: the meter has one row and no space for digits. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** A `~` prefix is how an estimate is marked apart from a measured figure. */
export function formatRate(
  tokensPerSecond: number | undefined,
  estimated: boolean,
): string {
  if (tokensPerSecond === undefined) return "—";
  const value =
    tokensPerSecond < 10
      ? tokensPerSecond.toFixed(1)
      : String(Math.round(tokensPerSecond));
  return `${estimated ? "~" : ""}${value} tok/s`;
}
