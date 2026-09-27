"use client";

import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import {
  ComposerCancelButton,
  ComposerSendButton,
} from "../components/assistant-ui/elements/thread.aui";
import { cn } from "../lib/utils";
import { COMPOSER_SHELL } from "./conversation";

export function SteerComposer({
  closedReason,
  continuing = false,
}: {
  closedReason: string | null;
  continuing?: boolean;
}) {
  const open = closedReason === null;
  const placeholder = continuing ? "Continue the agent…" : "Steer the agent…";
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div
        data-slot="aui_composer-shell"
        className={cn(COMPOSER_SHELL, "gap-2 p-(--composer-padding)")}
      >
        <ComposerPrimitive.Input
          placeholder={open ? placeholder : closedReason}
          aria-label={continuing ? "Continue the agent" : "Steer the agent"}
          disabled={!open}
          rows={1}
          enterKeyHint="send"
          className="aui-composer-input caret-primary text-foreground placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 ps-2.5">
          <span className="text-faint min-w-0 truncate text-[11px]">
            {open
              ? continuing
                ? "Starts a new turn with the agent’s earlier history"
                : "Delivered before the agent’s next step"
              : ""}
          </span>
          {open ? (
            <div className="flex items-center gap-1.5">
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerCancelButton label="Stop agent run" />
              </AuiIf>
              <ComposerSendButton
                tooltip={continuing ? "Continue" : "Steer"}
                label={continuing ? "Continue the agent run" : "Send steering message"}
              />
            </div>
          ) : null}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
