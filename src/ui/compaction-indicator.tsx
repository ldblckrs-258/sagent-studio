import { ScissorsIcon } from "lucide-react";
import { useChatStore } from "../chat/store";

/**
 * A summarization in flight, shown at the foot of the transcript.
 *
 * Compaction is a model round-trip with no stream behind it, so without this
 * the conversation sits still for seconds — on a manual `Compact now` and,
 * more confusingly, on an auto-compaction that fires before the user's turn.
 * It reads the engine-owned store rather than the assistant-ui runtime because
 * a compaction is not a run and never reaches the runtime.
 */
export function CompactionIndicator() {
  const compacting = useChatStore((s) =>
    s.activeThreadId
      ? s.compactingThreads[s.activeThreadId] === true
      : false,
  );
  if (!compacting) return null;
  return <CompactionIndicatorRow />;
}

/** The row itself, free of stores so a `renderToStaticMarkup` test can assert it. */
export function CompactionIndicatorRow() {
  return (
    <div
      data-slot="aui_compaction-indicator"
      role="status"
      className="border-rule text-muted animate-in fade-in flex items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5 text-xs"
    >
      <ScissorsIcon
        size={12}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0 motion-safe:animate-pulse"
      />
      <span className="shimmer motion-reduce:animate-none">
        Compacting the conversation into a summary…
      </span>
    </div>
  );
}
