import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { resolveContextCap } from "../chat/context-cap";
import { useChatStore } from "../chat/store";
import { useSession } from "../session/session-context";
import { useVaultStore } from "../vault/store";
import {
  formatPercent,
  formatRate,
  formatTokens,
  meterView,
} from "./context-meter-view";
import type { MeterView } from "./context-meter-view";

const ACTION =
  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] transition-colors hover:bg-paper-sunk hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rule disabled:cursor-not-allowed disabled:opacity-45";

/** How often the live rate is recomputed while a run streams. */
const TICK_MS = 500;

const EMPTY_MESSAGES: readonly UIMessage[] = [];

const BILLED_TITLE =
  "Total tokens billed across this conversation. Every turn re-sends the conversation, so this grows faster than the context does.";

/**
 * Tokens, context against the cap, and speed, directly under the composer.
 *
 * It reads the engine-owned store rather than the assistant-ui runtime because
 * usage and the live stream stats live there; only the skill directive is
 * forwarded into the runtime's own message metadata.
 */
export function ContextMeter() {
  const session = useSession();
  const messages = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.messages : undefined,
  );
  const config = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.config : undefined,
  );
  const liveStats = useChatStore((s) =>
    s.activeThreadId ? s.liveStats[s.activeThreadId] : undefined,
  );
  const running = useChatStore((s) =>
    s.activeThreadId ? (s.runningThreads[s.activeThreadId] ?? 0) > 0 : false,
  );
  const settings = useVaultStore((s) => s.settings);
  const [compacting, setCompacting] = useState(false);

  // The live rate is elapsed-time based, so it needs a clock of its own; the
  // store only changes when a chunk arrives. It ticks only during a run,
  // because the idle rate comes from the finished turn's own usage and ignores
  // this value entirely.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const view = meterView({
    messages: messages ?? EMPTY_MESSAGES,
    cap: resolveContextCap(settings, config),
    liveStats,
    running,
    now,
  });
  if (!view.visible) return null;

  const compact = async () => {
    const id = useChatStore.getState().activeThreadId;
    if (!id) return;
    setCompacting(true);
    try {
      await session.engineFor(id).compact(id);
    } catch (error) {
      useChatStore
        .getState()
        .setError(
          error instanceof Error
            ? error.message
            : "The conversation could not be compacted.",
        );
    } finally {
      setCompacting(false);
    }
  };

  return (
    <ContextMeterRow
      view={view}
      busy={running || compacting}
      onCompact={compact}
    />
  );
}

/**
 * The row itself, free of stores so a `renderToStaticMarkup` test can assert
 * the markup against a fixture view.
 */
export function ContextMeterRow({
  view,
  busy,
  onCompact,
}: {
  view: MeterView;
  busy: boolean;
  onCompact(): void;
}) {
  const estimateTitle =
    "Estimated from message length, because the provider reported no token usage.";
  const contextTitle = "Context the next request will send, against the cap.";
  return (
    <div
      data-slot="aui_context-meter"
      className="text-muted flex items-center gap-3 px-1 text-[11px]"
    >
      {/*
        "billed" rather than "tokens": this is the cumulative sum of every
        turn, and because each turn re-sends the conversation it grows far
        faster than the context beside it. Labelling it "tokens" invited the
        reading that it should be comparable to the context figure.
      */}
      <span className="shrink-0" title={BILLED_TITLE}>
        <span className="numeric font-mono text-ink">
          {formatTokens(view.totalTokens)}
        </span>{" "}
        billed
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span
          aria-hidden="true"
          className="bg-paper-sunk relative h-1 min-w-8 flex-1 overflow-hidden rounded-full"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              view.overThreshold ? "bg-caution" : "bg-accent",
            )}
            style={{ width: `${view.usedPercent}%` }}
          />
          <span
            className="bg-rule-strong absolute inset-y-0 w-px"
            style={{ left: `${view.thresholdPercent}%` }}
          />
        </span>
        <span
          className="numeric shrink-0 font-mono"
          title={view.estimated ? `${contextTitle} ${estimateTitle}` : contextTitle}
        >
          {view.estimated ? "~" : ""}
          {formatTokens(view.contextTokens)}/
          {formatTokens(view.maxContextTokens)}
          <span
            className={cn(
              "ml-1",
              view.overThreshold ? "text-caution" : "text-faint",
            )}
          >
            {formatPercent(view.usedPercent)}
          </span>
        </span>
      </span>

      <span
        className="numeric shrink-0 font-mono"
        {...(view.rateEstimated && view.tokensPerSecond !== undefined
          ? { title: estimateTitle }
          : {})}
      >
        {formatRate(view.tokensPerSecond, view.rateEstimated)}
      </span>

      <button
        type="button"
        className={ACTION}
        onClick={onCompact}
        disabled={busy}
        title="Summarize the conversation and continue from the summary"
      >
        Compact now
      </button>
    </div>
  );
}
