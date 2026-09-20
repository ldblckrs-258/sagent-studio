import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { resolveContextCap } from "../chat/context-cap";
import type { ResolvedContextCap } from "../chat/context-cap";
import { turnUsageFrom } from "../chat/usage";
import { defaultSettings } from "../vault/settings";
import type { Settings } from "../vault/settings";
import {
  formatPercent,
  formatRate,
  formatTokens,
  meterView,
} from "./context-meter-view";

function cap(context: Partial<Settings["context"]> = {}): ResolvedContextCap {
  const base = defaultSettings();
  return resolveContextCap({ ...base, context: { ...base.context, ...context } });
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(
  id: string,
  text: string,
  usage?: ReturnType<typeof turnUsageFrom>,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { chatStatus: "done", ...(usage ? { usage } : {}) },
  };
}

/* A thread whose last turn measured 800 of a 1000-token cap: at the threshold. */
const AT_THRESHOLD: UIMessage[] = [
  user("u1", "hi"),
  assistant("a1", "one", turnUsageFrom({ inputTokens: 300, outputTokens: 100 }, 2000)),
  user("u2", "again"),
  assistant("a2", "two", turnUsageFrom({ inputTokens: 700, outputTokens: 100 }, 4000)),
];

describe("meterView", () => {
  it("is hidden for an empty thread, so a new chat stays clean", () => {
    const view = meterView({
      messages: [],
      cap: cap(),
      running: false,
      now: 0,
    });
    expect(view.visible).toBe(false);
  });

  it("sums every recorded turn into the thread total", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 1000 }),
      running: false,
      now: 0,
    });
    expect(view.totalTokens).toBe(1200);
  });

  it("measures context against the cap as a percentage", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 1000 }),
      running: false,
      now: 0,
    });
    expect(view.contextTokens).toBe(800);
    expect(view.maxContextTokens).toBe(1000);
    expect(view.usedPercent).toBe(80);
    expect(view.estimated).toBe(false);
  });

  it("places the threshold tick where auto-compaction fires", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 1000, autoCompactRatio: 0.9 }),
      running: false,
      now: 0,
    });
    expect(view.thresholdPercent).toBe(90);
    expect(view.overThreshold).toBe(false);
  });

  it("crosses the threshold exactly when compaction would fire", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 1000, autoCompactRatio: 0.8 }),
      running: false,
      now: 0,
    });
    expect(view.overThreshold).toBe(true);
  });

  it("never reports over threshold while auto-compaction is off", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 100, autoCompactEnabled: false }),
      running: false,
      now: 0,
    });
    expect(view.overThreshold).toBe(false);
  });

  it("clamps the bar at full when the context exceeds the cap", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap({ maxContextTokens: 100 }),
      running: false,
      now: 0,
    });
    expect(view.usedPercent).toBe(100);
  });

  it("flags the context figure when it came from the estimate", () => {
    const view = meterView({
      messages: [user("u1", "a".repeat(40)), assistant("a1", "no usage here")],
      cap: cap(),
      running: false,
      now: 0,
    });
    expect(view.estimated).toBe(true);
  });

  it("reports the exact rate from the finished turn once idle", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap(),
      running: false,
      now: 0,
    });
    // 100 output tokens over 4 seconds.
    expect(view.tokensPerSecond).toBe(25);
    expect(view.rateEstimated).toBe(false);
  });

  it("estimates the rate from streamed characters during a run", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap(),
      liveStats: { startedAt: 1000, chars: 400 },
      running: true,
      now: 3000,
    });
    // 400 characters is 100 estimated tokens, over 2 seconds.
    expect(view.tokensPerSecond).toBe(50);
    expect(view.rateEstimated).toBe(true);
  });

  it("reports no rate for a run that has not streamed yet", () => {
    const view = meterView({
      messages: AT_THRESHOLD,
      cap: cap(),
      liveStats: { startedAt: 3000, chars: 0 },
      running: true,
      now: 3000,
    });
    expect(view.tokensPerSecond).toBeUndefined();
    expect(view.rateEstimated).toBe(true);
  });

  it("marks the rate as an estimate when the provider omitted usage", () => {
    const view = meterView({
      messages: [user("u1", "hi"), assistant("a1", "x", turnUsageFrom(undefined, 1000))],
      cap: cap(),
      running: false,
      now: 0,
    });
    expect(view.tokensPerSecond).toBeUndefined();
    expect(view.rateEstimated).toBe(true);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1500, "1.5k"],
    [12_400, "12k"],
    [128_000, "128k"],
    [2_400_000, "2.4M"],
  ])("renders %i as %s", (tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it("rounds to whole percent, because the bar is one row tall", () => {
    expect(formatPercent(79.6)).toBe("80%");
  });
});

describe("formatRate", () => {
  it("renders an em dash when there is no rate to show", () => {
    expect(formatRate(undefined, true)).toBe("—");
  });

  it("marks an estimate with a leading tilde and leaves a measurement bare", () => {
    expect(formatRate(42.4, true)).toBe("~42 tok/s");
    expect(formatRate(42.4, false)).toBe("42 tok/s");
  });

  it("keeps a decimal for a slow rate, so it does not read as zero", () => {
    expect(formatRate(1.24, false)).toBe("1.2 tok/s");
  });
});
