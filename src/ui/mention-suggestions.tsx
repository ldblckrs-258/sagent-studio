// Relative rather than the `@/` alias, for the same reason
// `slash-suggestions.tsx` is: the vitest config declares no alias.
import { cn } from "../lib/utils";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { composerThreadKey, useAttachmentStore } from "../chat/attachment-store";
import { useWorkspaceStore } from "../session/workspace-state";
import {
  directoryEntries,
  mentionIndex,
  rankEntries,
  scopeOfQuery,
  searchByName,
} from "./mention-index";
import type { MentionEntry } from "./mention-index";
import { completeMention, mentionQueryAt } from "./mention-suggestions-state";
import type { MentionQuery } from "./mention-suggestions-state";
import { moveHighlight } from "./slash-suggestions-state";
import { fileLookFor, folderLookFor } from "./panels/file-icon";

const ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-paper-sunk";

const CONTENT =
  "z-50 max-h-72 w-(--radix-popover-trigger-width) overflow-y-auto rounded-sm border border-rule-strong bg-surface p-1 shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)] outline-none";

const FALLBACK_DELAY_MS = 180;

function isSlashCommand(text: string): boolean {
  return text.startsWith("/");
}

/**
 * The composer's workspace-path list, wrapped around the composer input so it
 * can take its keys before the input does.
 *
 * Hand-rolled rather than built on `unstable_useMentionAdapter`: that adapter
 * searches a static, synchronous item pool, while this index is loaded from
 * `fs.list`, capped at 1000 entries, and falls back to a debounced glob for
 * anything beyond the cap.
 */
export function MentionSuggestions({ children }: { children: ReactNode }) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const fs = useWorkspaceStore((s) => s.fs);
  const add = useAttachmentStore((s) => s.add);

  const [caret, setCaret] = useState(0);
  const [entries, setEntries] = useState<MentionEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  // Keyed by the query it answers, so a stale result is ignored by comparison
  // rather than cleared from inside an effect.
  const [fallback, setFallback] = useState<{
    query: string;
    entries: MentionEntry[];
  }>({ query: "", entries: [] });
  const [highlight, setHighlight] = useState(0);
  // Keyed to the text it was dismissed at, so Escape hides the list for that
  // exact input and the next keystroke brings it back.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const match: MentionQuery | null = isSlashCommand(text)
    ? null
    : mentionQueryAt(text, caret);
  // A slash command owns the start of the text, so the two popovers are never
  // open at once.
  const mentioning = match !== null;

  useEffect(() => {
    if (!fs || !mentioning) return;
    let cancelled = false;
    void mentionIndex(fs).then((index) => {
      if (cancelled) return;
      setEntries(index.entries);
      setTruncated(index.truncated);
    });
    return () => {
      cancelled = true;
    };
  }, [fs, mentioning]);

  const query = match?.query ?? "";
  // A query that names a directory browses it directly, so a hidden folder the
  // index skips — `.opencode`, `.github` — is still reachable once the user
  // asks for it by name.
  const scope = mentioning ? scopeOfQuery(query) : null;
  const [scoped, setScoped] = useState<{
    scope: string;
    entries: MentionEntry[];
  } | null>(null);

  useEffect(() => {
    if (!fs || scope === null) return;
    let cancelled = false;
    void directoryEntries(fs, scope)
      .then((found) => {
        if (!cancelled) setScoped({ scope, entries: found });
      })
      .catch(() => {
        // The query names no real directory (`@chat/engine`), so the flat
        // index answers it instead.
        if (!cancelled) setScoped(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fs, scope]);

  const pool =
    scope !== null && scoped?.scope === scope ? scoped.entries : entries;
  const ranked = rankEntries(pool, query);

  // Only when the index is capped and nothing local matches, and never per
  // keystroke: the glob walks the whole folder again.
  useEffect(() => {
    if (!fs || !truncated || query.length < 2 || ranked.length > 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchByName(fs, query).then((found) => {
        if (!cancelled) setFallback({ query, entries: found });
      });
    }, FALLBACK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fs, truncated, query, ranked.length]);

  const matches =
    ranked.length > 0
      ? ranked
      : fallback.query === query
        ? fallback.entries
        : [];
  const open = match !== null && matches.length > 0 && dismissedAt !== text;
  const index = highlight < matches.length ? highlight : 0;

  const trackCaret = (event: SyntheticEvent<HTMLElement>) => {
    const target = event.target as HTMLTextAreaElement;
    if (typeof target.selectionStart !== "number") return;
    inputRef.current = target;
    setCaret(target.selectionStart);
  };

  /**
   * Takes an entry. A folder is *descended* rather than taken on Tab and on
   * click: the path grows by one segment and the list moves to its children,
   * so passing through `src/` on the way to a file never attaches `src/`
   * itself. Enter is the deliberate "attach this folder" key.
   */
  const apply = (entry: MentionEntry, options: { descend?: boolean } = {}) => {
    if (match === null) return;
    const descend = options.descend === true && entry.kind === "directory";
    const completion = completeMention(text, match, entry.path, { descend });
    aui.composer.setText(completion.text);
    if (!descend) {
      add(composerThreadKey(), {
        kind: entry.kind === "directory" ? "folder" : "file",
        path: entry.path,
        source: "mention",
      });
      setDismissedAt(completion.text);
    }
    setHighlight(0);
    setCaret(completion.caret);
    // `setText` moves a controlled textarea's caret to the end, so it is put
    // back where the user was typing after React has written the new value.
    const input = inputRef.current;
    if (input) {
      requestAnimationFrame(() => {
        input.setSelectionRange(completion.caret, completion.caret);
      });
    }
  };

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      setDismissedAt(text);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.stopPropagation();
      event.preventDefault();
      setHighlight(
        moveHighlight(
          { highlight: index, count: matches.length },
          event.key === "ArrowDown" ? 1 : -1,
        ),
      );
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (
        event.nativeEvent.isComposing ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const entry = matches[index];
      if (!entry) return;
      event.stopPropagation();
      event.preventDefault();
      apply(entry, { descend: event.key === "Tab" });
    }
  };

  return (
    <div
      className="relative"
      onKeyDownCapture={onKeyDownCapture}
      onKeyUp={trackCaret}
      onInput={trackCaret}
      onSelect={trackCaret}
      onClick={trackCaret}
    >
      <PopoverPrimitive.Root open={open}>
        <PopoverPrimitive.Anchor asChild>
          <div>{children}</div>
        </PopoverPrimitive.Anchor>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            className={CONTENT}
            // The composer keeps focus: the list is driven from the input.
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <MentionList
              matches={matches}
              highlight={index}
              truncated={truncated}
              onSelect={(entry) => apply(entry, { descend: true })}
              onHighlight={setHighlight}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

interface MentionListProps {
  matches: readonly MentionEntry[];
  highlight: number;
  truncated: boolean;
  onSelect(entry: MentionEntry): void;
  onHighlight(index: number): void;
}

/**
 * The rows themselves, free of the Radix popover context so a
 * `renderToStaticMarkup` test can assert an open list's markup.
 */
export function MentionList({
  matches,
  highlight,
  truncated,
  onSelect,
  onHighlight,
}: MentionListProps) {
  return (
    <>
      <ul role="listbox" aria-label="Workspace paths">
        {matches.map((entry, index) => {
          const look =
            entry.kind === "directory"
              ? folderLookFor(false)
              : fileLookFor(entry.path);
          const { Icon } = look;
          const parent = entry.path.slice(
            0,
            Math.max(entry.path.length - entry.name.length, 0),
          );
          return (
            <li key={entry.path}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={cn(ITEM, index === highlight && "bg-paper-sunk")}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onSelect(entry)}
              >
                <Icon
                  size={13}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn("shrink-0", look.className)}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-faint">{parent}</span>
                  <span className="text-ink">{entry.name}</span>
                </span>
                {entry.kind === "directory" ? (
                  <span className="text-faint shrink-0 font-mono text-[10px]">
                    {index === highlight ? "tab opens · enter attaches" : "folder"}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-faint border-rule mt-1 border-t px-2 pt-1 text-[10px]">
        The path stays in your message and travels as an attachment
        {truncated ? "; the index is capped at 1000 entries" : ""}.
      </p>
    </>
  );
}
