import { useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { useAttachmentStore } from "../chat/attachment-store";
import { defaultSlashEntries } from "../chat/slash";
import { useChatStore } from "../chat/store";
import { useSession } from "../session/session-context";
import { highlightSegments } from "./composer-highlight-state";
import { useRegistryVersion } from "./use-registry-version";

/**
 * Typography the overlay shares with the textarea. Any divergence here shows
 * up as drifting highlights, so the two lists are kept literally identical and
 * the input's own classes below repeat them rather than inheriting.
 */
const TYPOGRAPHY =
  "max-h-48 min-h-10 w-full px-2.5 py-1 text-base leading-6 whitespace-pre-wrap break-words";

const EMPTY_PATHS: ReadonlySet<string> = new Set();

/**
 * Colours completed slash commands and attached `@` mentions inside the
 * composer.
 *
 * A textarea cannot colour part of its own value, so the text is painted by a
 * mirror layer underneath it while the textarea itself renders transparent
 * glyphs (its caret and selection stay native). The mirror copies the input's
 * box and typography exactly and follows its scroll, which is what keeps the
 * two aligned as the message grows past the visible height.
 */
export function ComposerHighlight({ children }: { children: ReactNode }) {
  const session = useSession();
  // Skills hydrate after mount; without this a `/skill-id` would stay plain
  // until something unrelated re-rendered the composer.
  useRegistryVersion(session.skillRegistry);
  const text = useAuiState((s) => s.composer.text);
  const threadId = useChatStore((s) => s.activeThreadId ?? "");
  const chips = useAttachmentStore((s) => s.items[threadId]);

  const mcpState = useStore(session.mcp.store);
  const commands = useMemo(
    () => new Set(defaultSlashEntries(session.skillRegistry, session.mcp, mcpState).map((e) => e.id)),
    [session.skillRegistry, session.mcp, mcpState],
  );
  const paths = useMemo(
    () =>
      chips === undefined
        ? EMPTY_PATHS
        : new Set(chips.map((attachment) => attachment.path)),
    [chips],
  );
  const segments = highlightSegments(text, { commands, paths });

  const wrapperRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const textarea = wrapperRef.current?.querySelector("textarea");
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const sync = () => {
      mirror.scrollTop = textarea.scrollTop;
    };
    sync();
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
  }, [text]);

  return (
    <div ref={wrapperRef} className="relative">
      <div
        ref={mirrorRef}
        aria-hidden
        className={`pointer-events-none absolute inset-0 overflow-hidden text-ink ${TYPOGRAPHY}`}
      >
        {segments.map((segment, index) =>
          segment.kind === "plain" ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <span
              key={index}
              className={
                segment.kind === "command"
                  ? "rounded-sm bg-accent-soft text-accent"
                  : "rounded-sm bg-paper-sunk text-accent"
              }
            >
              {segment.text}
            </span>
          ),
        )}
        {/* A trailing newline collapses without this, so the mirror would stop
            scrolling one line before the textarea does. */}
        {text.endsWith("\n") ? " " : null}
      </div>
      {children}
    </div>
  );
}
