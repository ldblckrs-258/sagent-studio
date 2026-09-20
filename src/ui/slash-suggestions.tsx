// Relative rather than the `@/` alias that `composer-controls.tsx` uses: the
// vitest config declares no alias, so an aliased import is not importable from
// a test.
import { cn } from "../lib/utils";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { defaultSlashEntries } from "../chat/slash";
import type { SlashEntry } from "../chat/slash";
import { useSession } from "../session/session-context";
import {
  completionFor,
  moveHighlight,
  suggestionsFor,
} from "./slash-suggestions-state";
import { useRegistryVersion } from "./use-registry-version";

const ITEM =
  "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-paper-sunk";

const CONTENT =
  "z-50 max-h-72 w-(--radix-popover-trigger-width) overflow-y-auto rounded-sm border border-rule-strong bg-surface p-1 shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)] outline-none";

const TAG =
  "shrink-0 rounded-full border border-rule bg-paper-sunk px-1.5 text-[10px] leading-4 text-muted";

/**
 * The composer's command list, wrapped around the composer input so it can take
 * the keys it needs before the input does.
 *
 * It is open only while the composer text begins with a slash and something
 * matches, and it claims ArrowUp, ArrowDown, Enter, Tab and Escape only in that
 * state, so ordinary typing and ordinary sending are untouched. The keys are
 * intercepted during capture and their propagation stopped, because
 * `ComposerPrimitive.Input`'s own Enter handler does not consult
 * `defaultPrevented` and would otherwise send a half-typed command.
 *
 * The popover is hand-built on Radix rather than taken from
 * `unstable_useSlashCommandAdapter`, whose `ComposerTriggerPopover` companion
 * this version of assistant-ui does not export.
 */
export function SlashSuggestions({ children }: { children: ReactNode }) {
  const session = useSession();
  // Skills hydrate after mount, so without this the list can be built from an
  // empty registry and never rebuilt.
  useRegistryVersion(session.skillRegistry);
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const [highlight, setHighlight] = useState(0);
  // Keyed to the text it was dismissed at, so Escape hides the list for that
  // exact input and the next keystroke brings it back.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const entries = useMemo(
    () => defaultSlashEntries(session.skillRegistry),
    [session.skillRegistry],
  );
  const matches = useMemo(() => suggestionsFor(entries, text), [entries, text]);
  const open = matches.length > 0 && dismissedAt !== text;
  const index = highlight < matches.length ? highlight : 0;

  const apply = (entry: SlashEntry) => {
    const completion = completionFor(entry, text);
    aui.composer.setText(completion);
    setDismissedAt(completion);
    setHighlight(0);
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
      // Shift+Enter is a newline and Cmd/Ctrl+Shift+Enter steers, both of
      // which belong to the composer; an IME commit is not a selection either.
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
      apply(entry);
    }
  };

  return (
    <div className="relative" onKeyDownCapture={onKeyDownCapture}>
      <PopoverPrimitive.Root open={open}>
        <PopoverPrimitive.Anchor asChild>
          <div>{children}</div>
        </PopoverPrimitive.Anchor>
        <SlashSuggestionsContent
          matches={matches}
          highlight={index}
          onSelect={apply}
          onHighlight={setHighlight}
        />
      </PopoverPrimitive.Root>
    </div>
  );
}

function SlashSuggestionsContent(props: SlashListProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="top"
        align="start"
        sideOffset={8}
        className={CONTENT}
        // The composer keeps focus: the list is driven from the input, and
        // moving focus here would break typing mid-command.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SlashSuggestionsList {...props} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

interface SlashListProps {
  matches: readonly SlashEntry[];
  highlight: number;
  onSelect(entry: SlashEntry): void;
  onHighlight(index: number): void;
}

/**
 * The rows themselves, free of the Radix popover context so a
 * `renderToStaticMarkup` test can assert an open list's markup.
 */
export function SlashSuggestionsList({
  matches,
  highlight,
  onSelect,
  onHighlight,
}: SlashListProps) {
  return (
    <ul role="listbox" aria-label="Commands and skills">
      {matches.map((entry, index) => (
        <li key={`${entry.kind}:${entry.id}`}>
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            className={cn(ITEM, index === highlight && "bg-paper-sunk")}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(entry)}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-ink">/{entry.id}</span>
                {entry.argumentHint ? (
                  <span className="font-mono text-faint">
                    {entry.argumentHint}
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-muted">
                {entry.description}
              </span>
            </span>
            {entry.source === "workspace" ? (
              <span className={TAG}>workspace</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
