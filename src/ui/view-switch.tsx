import type { KeyboardEvent } from "react";
import { SHELL_VIEWS, VIEW_LABEL } from "./shell-view";
import type { ShellView } from "./shell-view";

export function ViewSwitch({
  view,
  onChange,
  chatBadge,
}: {
  view: ShellView;
  onChange(view: ShellView): void;
  chatBadge: boolean;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = SHELL_VIEWS.indexOf(view);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % SHELL_VIEWS.length
        : (index - 1 + SHELL_VIEWS.length) % SHELL_VIEWS.length;
    onChange(SHELL_VIEWS[next]);
  };
  return (
    <div
      role="tablist"
      aria-label="View"
      onKeyDown={onKeyDown}
      className="flex items-center gap-0.5 rounded-sm border border-rule p-0.5"
    >
      {SHELL_VIEWS.map((entry) => {
        const badge = entry === "chat" && chatBadge && view !== "chat";
        return (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={view === entry}
            tabIndex={view === entry ? 0 : -1}
            aria-label={badge ? `${VIEW_LABEL[entry]} (approval pending)` : VIEW_LABEL[entry]}
            onClick={() => onChange(entry)}
            className={`relative rounded-sm px-2 py-1 text-sm transition-colors ${
              view === entry ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"
            }`}
          >
            {VIEW_LABEL[entry]}
            {badge ? (
              <span
                aria-hidden
                data-approval-badge
                className="border-caution-rule bg-caution absolute -right-0.5 -top-0.5 size-2 rounded-full border"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
