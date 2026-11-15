import {
  ChevronRight,
  Download,
  FolderDown,
  ImageOff,
  Images,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ImageZoom } from "../../components/assistant-ui/elements/image";
import type { RunGroup } from "../../playground/run-groups";
import { usePlaygroundStore } from "../../playground/state";
import type { ActiveRun } from "../../playground/state";
import { imageId } from "../../playground/store";
import type { OutputRef, RunMeta } from "../../playground/store";
import { isTerminal } from "../../playground/types";
import type { RunStatus } from "../../playground/types";
import type { BadgeTone } from "../primitives";
import { Badge, Button, EmptyState, IconButton } from "../primitives";

const STATUS_TONE: Record<RunStatus, BadgeTone> = {
  starting: "accent",
  processing: "accent",
  succeeded: "positive",
  failed: "danger",
  canceled: "neutral",
  interrupted: "caution",
  expired: "caution",
};

const STATUS_HINT: Partial<Record<RunStatus, string>> = {
  expired: "The provider removes run data after an hour, so this run can no longer be followed.",
  interrupted: "The app stopped following this run before it finished.",
};

function firstLine(input: Record<string, unknown>): string {
  const prompt = input.prompt;
  if (typeof prompt !== "string") return "";
  return prompt.split("\n")[0].slice(0, 200);
}

function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <span className="numeric shrink-0 font-mono text-xs text-muted">{Math.max(0, Math.floor((now - since) / 1000))}s</span>
  );
}

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

type TileLayout = "row" | "wall";

const IMAGE_CLASS: Record<TileLayout, string> = {
  row: "block h-auto max-h-75 w-auto max-w-full",
  wall: "block h-auto max-h-50 w-auto max-w-full",
};

const SLOT_CLASS: Record<TileLayout, string> = {
  row: "size-48 max-w-full",
  wall: "size-50 max-w-full",
};

function StoredImage({ id, mime, alt, layout }: { id: string; mime: string; alt: string; layout: TileLayout }) {
  const { ref, visible } = useInView<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const store = usePlaygroundStore.getState();
    let cancelled = false;
    let acquired = false;
    store
      .imageUrl(id, mime)
      .then((next) => {
        if (cancelled) {
          store.releaseImageUrl(id);
          return;
        }
        acquired = true;
        setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (acquired) store.releaseImageUrl(id);
    };
  }, [id, mime, visible]);

  return (
    <div ref={ref}>
      {failed ? (
        <div className={`flex items-center justify-center text-faint ${SLOT_CLASS[layout]}`} title="The image could not be read.">
          <ImageOff size={16} strokeWidth={1.75} aria-hidden="true" />
        </div>
      ) : url ? (
        <ImageZoom src={url} alt={alt}>
          <img src={url} alt={alt} className={IMAGE_CLASS[layout]} />
        </ImageZoom>
      ) : (
        <div className={`bg-paper-sunk motion-safe:animate-pulse ${SLOT_CLASS[layout]}`} />
      )}
    </div>
  );
}

export interface RunActions {
  onUseSettings(run: RunMeta): void;
  onRerun(run: RunMeta): void;
  onDownload(run: RunMeta, output: OutputRef): void;
  onSaveToFolder(run: RunMeta, output: OutputRef): void;
  onRetryDownload(run: RunMeta): void;
}

export type RunsView = "list" | "gallery";

function OutputTile({
  run,
  output,
  folderName,
  actions,
  layout,
  withSettings = false,
}: {
  run: RunMeta;
  output: OutputRef;
  folderName: string | null;
  actions: RunActions;
  layout: TileLayout;
  withSettings?: boolean;
}) {
  const prompt = firstLine(run.input);
  return (
    <figure
      title={withSettings && prompt ? prompt : undefined}
      className={`group relative overflow-hidden rounded-sm border border-rule bg-paper-sunk max-w-full`}
    >
      <StoredImage
        id={imageId(run.id, "output", output.index)}
        mime={output.mime}
        alt={`${run.modelLabel} output ${output.index + 1}`}
        layout={layout}
      />
      <figcaption className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-sm border border-rule bg-surface opacity-0 transition-opacity duration-150 ease-out-quart group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {withSettings ? (
          <IconButton label="Use settings" onClick={() => actions.onUseSettings(run)}>
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        ) : null}
        <IconButton label="Download" onClick={() => actions.onDownload(run, output)}>
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={folderName ? `Save to ${folderName}` : "Save to folder"}
          onClick={() => actions.onSaveToFolder(run, output)}
        >
          <FolderDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </figcaption>
    </figure>
  );
}

function Sweep() {
  return (
    <div className="relative h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-paper-sunk">
      <span className="block h-full w-1/3 rounded-full bg-accent motion-safe:animate-[ingest-sweep_1.2s_ease-in-out_infinite]" />
    </div>
  );
}

function statusLabel(run: RunMeta, live: ActiveRun | undefined): string {
  return live?.cancelRequested ? "canceling" : run.status;
}

function RunBody({ run, live, actions }: {
  run: RunMeta;
  live: ActiveRun | undefined;
  actions: RunActions;
}) {
  const cancel = usePlaygroundStore((s) => s.cancel);
  const [error, setError] = useState<string | null>(null);
  const hint = STATUS_HINT[run.status];
  const active = live !== undefined;
  const canRetryDownload =
    !active && run.status === "succeeded" && run.outputs.length === 0 && Boolean(run.error) && Boolean(run.providerRunId);
  return (
    <>
      {active ? (
        <div className="flex items-center gap-3">
          <Sweep />
          <Elapsed since={run.createdAt} />
          {isTerminal(run.status) ? null : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={live.cancelRequested}
              onClick={() =>
                void cancel(run.id).catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
              }
              icon={<Square size={12} strokeWidth={2} aria-hidden="true" />}
            >
              Cancel
            </Button>
          )}
        </div>
      ) : null}

      {hint ? <p className="text-xs text-caution">{hint}</p> : null}
      {run.error ? (
        <p className="rounded-sm bg-danger-soft px-2 py-1.5 font-mono text-xs leading-relaxed text-danger">{run.error}</p>
      ) : null}
      {canRetryDownload ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => actions.onRetryDownload(run)}
            icon={<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />}
          >
            Retry download
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}

      {run.outputJson !== undefined ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-rule bg-paper-sunk px-2 py-1.5 font-mono text-xs text-muted">
          {JSON.stringify(run.outputJson, null, 2)}
        </pre>
      ) : null}
    </>
  );
}

function OutputSlot({ run, live, folderName, actions }: {
  run: RunMeta;
  live: ActiveRun | undefined;
  folderName: string | null;
  actions: RunActions;
}) {
  if (run.outputs.length > 0) {
    return (
      <div className="flex flex-wrap items-start gap-3">
        {run.outputs.map((output) => (
          <OutputTile key={output.index} run={run} output={output} folderName={folderName} actions={actions} layout="row" />
        ))}
      </div>
    );
  }
  if (!live) return null;
  return (
    <div
      aria-hidden="true"
      className="size-48 max-w-full rounded-sm border border-rule bg-paper-sunk motion-safe:animate-pulse"
    />
  );
}

function RunCell({ run, live, folderName, actions, now, onDelete }: {
  run: RunMeta;
  live: ActiveRun | undefined;
  folderName: string | null;
  actions: RunActions;
  now: number;
  onDelete(): void;
}) {
  const hasSlot = run.outputs.length > 0 || live !== undefined;
  return (
    <section
      data-run-id={run.id}
      aria-label={`Run from ${new Date(run.createdAt).toLocaleString()}`}
      className={`flex max-w-full flex-col gap-2 ${hasSlot ? "" : "w-75"}`}
    >
      <OutputSlot run={run} live={live} folderName={folderName} actions={actions} />
      <div className={`flex flex-col gap-2 ${hasSlot ? "w-0 min-w-full" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <RunStamp run={run} live={live} now={now} />
          </span>
          <IconButton label="Delete run" tone="danger" onClick={onDelete}>
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </div>
        <RunBody run={run} live={live} actions={actions} />
      </div>
    </section>
  );
}

function RunStamp({ run, live, now }: { run: RunMeta; live: ActiveRun | undefined; now: number }) {
  return (
    <>
      <Badge tone={STATUS_TONE[run.status]} size="sm">
        {statusLabel(run, live)}
      </Badge>
      {run.predictTime !== undefined ? (
        <span className="numeric font-mono text-xs text-faint" title="Prediction time">
          {run.predictTime.toFixed(1)}s
        </span>
      ) : null}
      <time
        dateTime={new Date(run.createdAt).toISOString()}
        title={new Date(run.createdAt).toLocaleString()}
        className="text-xs text-faint"
      >
        {formatAgo(run.createdAt, now)}
      </time>
    </>
  );
}

function GroupCard({ group, active, collapsed, onToggle, folderName, actions, now }: {
  group: RunGroup;
  active: Record<string, ActiveRun>;
  collapsed: boolean;
  onToggle(): void;
  folderName: string | null;
  actions: RunActions;
  now: number;
}) {
  const remove = usePlaygroundStore((s) => s.remove);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();
  const [newest] = group.runs;
  const many = group.runs.length > 1;
  const prompt = firstLine(newest.input);
  const images = group.runs.reduce((total, run) => total + run.outputs.length, 0);
  const running = group.runs.filter((run) => run.id in active).length;
  const report = (task: Promise<unknown>) =>
    void task.catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));

  return (
    <article
      data-run-id={newest.id}
      data-run-count={group.runs.length}
      className="flex flex-col gap-3 border-t border-rule py-4 first:border-t-0 first:pt-1"
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
          className="group/toggle flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left"
        >
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`mt-0.5 shrink-0 text-faint transition-transform duration-150 ease-out-quart group-hover/toggle:text-ink ${
              collapsed ? "" : "rotate-90"
            }`}
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate font-mono text-xs text-ink" title={newest.model}>
                {newest.modelLabel}
              </span>
              {many ? (
                <>
                  <Badge tone="neutral" size="sm" title="Runs with these settings">
                    {`×${group.runs.length}`}
                  </Badge>
                  {running > 0 ? (
                    <Badge tone="accent" size="sm">
                      {running === 1 ? "1 running" : `${running} running`}
                    </Badge>
                  ) : null}
                  <time
                    dateTime={new Date(newest.createdAt).toISOString()}
                    title={new Date(newest.createdAt).toLocaleString()}
                    className="text-xs text-faint"
                  >
                    {formatAgo(newest.createdAt, now)}
                  </time>
                </>
              ) : (
                <RunStamp run={newest} live={active[newest.id]} now={now} />
              )}
              {collapsed && images > 0 ? (
                <span className="numeric text-xs text-faint">{images === 1 ? "1 image" : `${images} images`}</span>
              ) : null}
            </span>
            {prompt ? (
              <span className={`${collapsed ? "line-clamp-1" : "line-clamp-2"} text-sm leading-relaxed text-ink`}>
                {prompt}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Use settings" onClick={() => actions.onUseSettings(newest)}>
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
          <IconButton label="Re-run" onClick={() => actions.onRerun(newest)}>
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={many ? `Delete ${group.runs.length} runs` : "Delete run"}
            tone="danger"
            onClick={() => report(Promise.all(group.runs.map((run) => remove(run.id))))}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      {collapsed ? null : (
        <div id={bodyId} className="flex flex-col gap-3 pl-6">
          {many ? (
            <div className="flex flex-wrap items-start gap-x-4 gap-y-6">
              {group.runs.map((run) => (
                <RunCell
                  key={run.id}
                  run={run}
                  live={active[run.id]}
                  folderName={folderName}
                  actions={actions}
                  now={now}
                  onDelete={() => report(remove(run.id))}
                />
              ))}
            </div>
          ) : (
            <>
              <RunBody run={newest} live={active[newest.id]} actions={actions} />
              <OutputSlot run={newest} live={active[newest.id]} folderName={folderName} actions={actions} />
            </>
          )}
        </div>
      )}
    </article>
  );
}

function GalleryGrid({ runs, active, folderName, actions }: {
  runs: readonly RunMeta[];
  active: Record<string, ActiveRun>;
  folderName: string | null;
  actions: RunActions;
}) {
  const pending = runs.filter((run) => run.id in active && run.outputs.length === 0);
  const withImages = runs.filter((run) => run.outputs.length > 0);
  const without = runs.length - pending.length - withImages.length;

  return (
    <div className="flex flex-col gap-3">
      {without > 0 ? (
        <p className="text-xs text-faint">
          {without === 1 ? "1 run has no image." : `${without} runs have no image.`} List view shows them.
        </p>
      ) : null}
      {pending.length === 0 && withImages.length === 0 ? (
        <EmptyState title="No images yet." hint="Runs that finish with an image appear here." />
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {pending.map((run) => (
            <div
              key={run.id}
              data-run-id={run.id}
              className="flex size-50 max-w-full flex-col justify-end gap-2 rounded-sm border border-rule bg-paper-sunk p-3"
            >
              <span className="line-clamp-2 text-xs text-muted">{firstLine(run.input) || run.modelLabel}</span>
              <div className="flex items-center gap-2">
                <Sweep />
                <Elapsed since={run.createdAt} />
              </div>
            </div>
          ))}
          {withImages.flatMap((run) =>
            run.outputs.map((output) => (
              <OutputTile
                key={`${run.id}:${output.index}`}
                run={run}
                output={output}
                folderName={folderName}
                actions={actions}
                layout="wall"
                withSettings
              />
            )),
          )}
        </div>
      )}
    </div>
  );
}

export function RunGallery({ view, runs, groups, collapsed, onToggle, folderName, actions }: {
  view: RunsView;
  runs: readonly RunMeta[];
  groups: readonly RunGroup[];
  collapsed: ReadonlySet<string>;
  onToggle(key: string): void;
  folderName: string | null;
  actions: RunActions;
}) {
  const active = usePlaygroundStore((s) => s.active);
  const now = useNow(30_000);

  if (runs.length === 0) {
    return (
      <div className="py-12">
        <EmptyState
          icon={<Images size={18} strokeWidth={1.75} aria-hidden="true" />}
          title="No runs yet."
          hint="Pick a model, set its input, and press Run. Outputs are kept in this browser, encrypted."
        />
      </div>
    );
  }
  if (view === "gallery") {
    return <GalleryGrid runs={runs} active={active} folderName={folderName} actions={actions} />;
  }
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <GroupCard
          key={group.key}
          group={group}
          active={active}
          collapsed={collapsed.has(group.key)}
          onToggle={() => onToggle(group.key)}
          folderName={folderName}
          actions={actions}
          now={now}
        />
      ))}
    </div>
  );
}
