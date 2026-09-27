"use client";

/*
  Conversation chrome shared by the main thread and the Agents panel. The two
  surfaces render the same assistant-ui message components, so the only thing
  that must not drift is the message field itself.
*/

import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The app's one message field: a bordered, rounded container the whole composer
 * sits in. The radius and background read from the same custom properties the
 * thread root sets, with a fallback for the panel, which mounts outside it.
 */
export const COMPOSER_SHELL =
  "border-foreground/10 focus-within:border-foreground/25 rounded-(--composer-radius,1rem) bg-(--composer-bg,var(--color-surface)) flex w-full cursor-text flex-col border transition-[border-color] duration-150 ease-out-quart";

/** A user turn: a sunk bubble aligned to the end of the column. */
export function UserBubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-paper-sunk text-foreground rounded-(--composer-radius,1rem) px-4 py-2 wrap-break-word",
        className,
      )}
    >
      {children}
    </div>
  );
}
