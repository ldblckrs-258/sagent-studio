import {
  BookOpen,
  Copy,
  Eye,
  File,
  FileDiff,
  FilePlus2,
  FileSearch,
  FileText,
  Flag,
  Folder,
  FolderInput,
  FolderPlus,
  FolderTree,
  GitCompare,
  History,
  Info,
  ScrollText,
  Search,
  ShieldCheck,
  TextSearch,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useFileViewStore } from "@/session/file-view-state";
import {
  ToolChip,
  ToolCode,
  ToolKeyValues,
  ToolSection,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  basename,
  formatAge,
  formatBytes,
  formatClock,
  formatTimestamp,
  pluralize,
  shortHash,
} from "../helpers";

const LIST_CAP = 200;

function entryIcon(kind: unknown) {
  return kind === "directory" ? Folder : File;
}

function EntryList({ entries }: { entries: Array<Record<string, unknown>> }) {
  const shown = entries.slice(0, LIST_CAP);
  return (
    <ul className="flex flex-col">
      {shown.map((entry, index) => {
        const path = asString(entry.path) ?? asString(entry.name) ?? "";
        const Icon = entryIcon(entry.kind);
        return (
          <li key={`${path}:${index}`} className="flex min-w-0 items-center gap-2 py-0.5">
            <Icon className="text-muted size-3.5 shrink-0" aria-hidden="true" />
            <span
              className="text-foreground/90 truncate font-mono text-xs"
              title={path}
            >
              {path}
            </span>
          </li>
        );
      })}
      {entries.length > shown.length && (
        <li className="text-faint py-0.5 text-[10px]">
          {entries.length - shown.length} more not shown
        </li>
      )}
    </ul>
  );
}

function listDirDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const entries = asArray(value.entries).map(asRecord);
  return (
    <ToolSection label="Entries" count={entries.length}>
      {entries.length === 0 ? (
        <p className="text-faint text-xs">The folder is empty.</p>
      ) : (
        <EntryList entries={entries} />
      )}
      {value.truncated === true && (
        <p className="text-caution text-[10px]">
          Listing stopped at the entry cap.
        </p>
      )}
    </ToolSection>
  );
}

function readFileDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const content = asString(value.content) ?? "";
  const revision = shortHash(value.revision);
  return (
    <div className="flex flex-col gap-2">
      {content.length > 0 && <ToolCode text={content} limit={400} />}
      {value.truncated === true && (
        <ToolChip tone="caution">window truncated</ToolChip>
      )}
      {revision !== undefined && (
        <p className="text-faint font-mono text-[10px]">revision {revision}</p>
      )}
    </div>
  );
}

function writeFileDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const before = shortHash(value.before_hash);
  const after = shortHash(value.after_hash);
  return (
    <ToolKeyValues
      rows={[
        { key: "bytes", value: formatBytes(asNumber(value.bytes)), mono: true },
        { key: "applied", value: value.applied === true ? "yes" : "no" },
        ...(before !== undefined || after !== undefined
          ? [
              {
                key: "revision",
                value: `${before ?? "new"} to ${after ?? "new"}`,
                mono: true,
              },
            ]
          : []),
      ]}
    />
  );
}

function pathOnlyDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const path = asString(value.path);
  return path !== undefined ? (
    <p className="text-foreground/90 font-mono text-xs break-all">{path}</p>
  ) : null;
}

function statDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  return (
    <ToolKeyValues
      rows={[
        { key: "path", value: asString(value.path) ?? "", mono: true },
        { key: "kind", value: asString(value.kind) ?? "unknown" },
        { key: "size", value: formatBytes(asNumber(value.size)), mono: true },
      ]}
    />
  );
}

function fileInfoDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const lastModified = formatTimestamp(value.lastModifiedIso) ?? formatClock(asNumber(value.lastModified));
  const age = formatAge(asNumber(value.ageMs));
  const counts = (key: string) =>
    typeof value[key] === "number" ? String(value[key]) : "too large to count";
  const extension = asString(value.extension);
  return (
    <ToolKeyValues
      rows={[
        { key: "path", value: asString(value.path) ?? "", mono: true },
        { key: "kind", value: asString(value.kind) ?? "unknown" },
        ...(extension !== undefined
          ? [{ key: "extension", value: extension, mono: true }]
          : []),
        { key: "size", value: formatBytes(asNumber(value.size)), mono: true },
        { key: "lines", value: counts("lines"), mono: true },
        { key: "non-empty", value: counts("nonEmptyLines"), mono: true },
        { key: "characters", value: counts("characters"), mono: true },
        ...(lastModified !== undefined
          ? [{ key: "modified", value: `${lastModified}${age ? ` (${age})` : ""}`, mono: true }]
          : []),
      ]}
    />
  );
}

interface EditPair {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function readEditPairs(args: Record<string, unknown>): EditPair[] {
  const edits = asArray(args.edits).map(asRecord);
  if (edits.length > 0) {
    return edits.map((edit) => ({
      oldString: asString(edit.old_string) ?? "",
      newString: asString(edit.new_string) ?? "",
      replaceAll: edit.replace_all === true,
    }));
  }
  const oldString = asString(args.old_string);
  const newString = asString(args.new_string);
  if (oldString === undefined && newString === undefined) return [];
  return [
    {
      oldString: oldString ?? "",
      newString: newString ?? "",
      replaceAll: args.replace_all === true,
    },
  ];
}

function EditHunks({ pairs }: { pairs: EditPair[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {pairs.map((pair, index) => (
        <li key={index} className="flex flex-col gap-1">
          {pair.oldString.length > 0 && (
            <pre className="border-danger-rule bg-danger-soft text-danger max-h-40 overflow-auto rounded-sm border p-1.5 font-mono text-xs whitespace-pre">
              {pair.oldString.split("\n").map((line) => `- ${line}`).join("\n")}
            </pre>
          )}
          {pair.newString.length > 0 ? (
            <pre className="border-rule bg-paper-sunk/60 text-positive max-h-40 overflow-auto rounded-sm border p-1.5 font-mono text-xs whitespace-pre">
              {pair.newString.split("\n").map((line) => `+ ${line}`).join("\n")}
            </pre>
          ) : (
            <p className="text-faint text-xs">Removes the matched text.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function editFileDetail({ args, envelope }: ToolDetailProps) {
  const pairs = readEditPairs(args);
  if (!envelope?.ok) {
    return pairs.length > 0 ? (
      <ToolSection label="Requested edits">
        <EditHunks pairs={pairs} />
      </ToolSection>
    ) : null;
  }
  const value = asRecord(envelope.value);
  const applied = value.applied === true;
  const replacements = asNumber(value.replacements) ?? 0;
  const bytesDelta = asNumber(value.bytesDelta);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone={applied ? "positive" : "neutral"}>
          {applied ? "applied" : "no change"}
        </ToolChip>
        {asString(value.reason) === "already_satisfied" && (
          <ToolChip tone="accent">already satisfied</ToolChip>
        )}
        {bytesDelta !== undefined && bytesDelta !== 0 && (
          <span className="text-faint numeric font-mono text-[10px]">
            {bytesDelta > 0 ? "+" : ""}
            {formatBytes(Math.abs(bytesDelta))}
          </span>
        )}
      </div>
      {pairs.length > 0 && (
        <ToolSection label="Edits" count={pairs.length}>
          <EditHunks pairs={pairs} />
        </ToolSection>
      )}
      {replacements > 0 && (
        <p className="text-faint numeric font-mono text-[10px]">
          {pluralize(replacements, "replacement")}
        </p>
      )}
    </div>
  );
}

interface SearchHit {
  path: string;
  line: number;
  text: string;
}

function readHits(value: Record<string, unknown>): SearchHit[] {
  return asArray(value.hits).map((hit) => {
    const record = asRecord(hit);
    return {
      path: asString(record.path) ?? "",
      line: asNumber(record.line) ?? 0,
      text: asString(record.text) ?? "",
    };
  });
}

function HitList({ hits }: { hits: SearchHit[] }) {
  const shown = hits.slice(0, LIST_CAP);
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((hit, index) => (
        <li
          key={`${hit.path}:${hit.line}:${index}`}
          className="min-w-0 rounded-sm border border-rule/70 bg-paper-sunk/30 px-2 py-1"
        >
          <span className="text-faint numeric font-mono text-[10px]">
            {hit.path}:{hit.line}
          </span>
          <span className="text-foreground/90 block truncate font-mono text-xs" title={hit.text}>
            {hit.text.trim()}
          </span>
        </li>
      ))}
      {hits.length > shown.length && (
        <li className="text-faint text-[10px]">
          {hits.length - shown.length} more hits not shown
        </li>
      )}
    </ul>
  );
}

function searchDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const hits = readHits(value);
  const skipped = asArray(value.skipped).map(asRecord);
  return (
    <div className="flex flex-col gap-3">
      {hits.length > 0 ? (
        <ToolSection label="Matches" count={hits.length}>
          <HitList hits={hits} />
        </ToolSection>
      ) : (
        <p className="text-muted text-xs">No matching lines.</p>
      )}
      <p className="text-faint numeric font-mono text-[10px]">
        scanned {asNumber(value.filesScanned) ?? 0} files
        {value.truncated === true ? ", truncated" : ""}
      </p>
      {hits.length === 0 && skipped.length > 0 && (
        <ToolSection label="Skipped">
          <ToolKeyValues
            rows={skipped.slice(0, 12).map((entry, index) => ({
              key: asString(entry.path) ?? String(index),
              value: asString(entry.reason) ?? "",
              mono: true,
            }))}
          />
        </ToolSection>
      )}
    </div>
  );
}

function findLinesDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const hits = readHits(value);
  return (
    <div className="flex flex-col gap-2">
      {hits.length > 0 ? (
        <HitList hits={hits} />
      ) : (
        <p className="text-muted text-xs">No matching lines in the file.</p>
      )}
      {value.truncated === true && (
        <ToolChip tone="caution">result truncated</ToolChip>
      )}
    </div>
  );
}

function transferDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  return (
    <ToolKeyValues
      rows={[
        { key: "from", value: asString(value.from) ?? "", mono: true },
        { key: "to", value: asString(value.to) ?? "", mono: true },
        { key: "kind", value: asString(value.kind) ?? "unknown" },
        ...(asNumber(value.size) !== undefined
          ? [{ key: "size", value: formatBytes(asNumber(value.size)), mono: true }]
          : []),
      ]}
    />
  );
}

/* ---------------------------------------------------------------- history -- */

function checkpointDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  return (
    <ToolKeyValues
      rows={[
        { key: "id", value: asString(value.id) ?? "", mono: true },
        { key: "label", value: asString(value.label) ?? "none" },
        { key: "time", value: formatClock(asNumber(value.time)) ?? "", mono: true },
        { key: "journal", value: pluralize(asNumber(value.entries) ?? 0, "entry"), mono: true },
      ]}
    />
  );
}

function PathList({ label, paths, tone }: { label: string; paths: string[]; tone?: "positive" | "danger" | "caution" }) {
  if (paths.length === 0) return null;
  return (
    <ToolSection label={label} count={paths.length}>
      <ul className="flex flex-col">
        {paths.slice(0, LIST_CAP).map((path, index) => (
          <li key={`${path}:${index}`} className="truncate font-mono text-xs">
            <span
              className={cn(
                tone === "positive" && "text-positive",
                tone === "danger" && "text-danger",
                tone === "caution" && "text-caution",
                tone === undefined && "text-foreground/90",
              )}
            >
              {path}
            </span>
          </li>
        ))}
      </ul>
    </ToolSection>
  );
}

function restoreDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const readList = (key: string) =>
    asArray(value[key]).filter((item): item is string => typeof item === "string");
  const restored = readList("restored");
  const removed = readList("removed");
  const skipped = readList("skipped");
  const unrestorable = readList("unrestorable");
  return (
    <div className="flex flex-col gap-3">
      <PathList label="Restored" paths={restored} tone="positive" />
      <PathList label="Removed" paths={removed} tone="danger" />
      <PathList label="Skipped" paths={skipped} tone="caution" />
      <PathList label="Unrestorable" paths={unrestorable} tone="caution" />
      {restored.length + removed.length + skipped.length + unrestorable.length === 0 && (
        <p className="text-muted text-xs">Already at the checkpoint state.</p>
      )}
    </div>
  );
}

function DiffBlock({ text }: { text: string }) {
  const lines = text.split("\n").slice(0, 400);
  return (
    <pre className="max-h-64 overflow-auto rounded-sm border border-rule bg-paper-sunk/50 p-2 font-mono text-xs leading-relaxed whitespace-pre">
      {lines.map((line, index) => {
        const tone = line.startsWith("+++") || line.startsWith("---")
          ? "text-faint"
          : line.startsWith("+")
            ? "text-positive"
            : line.startsWith("-")
              ? "text-danger"
              : line.startsWith("@@")
                ? "text-accent"
                : "text-foreground/90";
        return (
          <span key={index} className={cn("block", tone)}>
            {line.length > 0 ? line : "\u00a0"}
          </span>
        );
      })}
    </pre>
  );
}

function diffDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const text = asString(value.diff) ?? "";
  const changed = value.changed === true;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone={changed ? "accent" : "neutral"}>
          {changed ? "changed" : "unchanged"}
        </ToolChip>
        <span className="text-faint numeric font-mono text-[10px]">
          +{asNumber(value.addedLines) ?? 0} -{asNumber(value.removedLines) ?? 0}
        </span>
        {value.truncated === true && <ToolChip tone="caution">diff truncated</ToolChip>}
      </div>
      {text.length > 0 && <DiffBlock text={text} />}
    </div>
  );
}

function historyDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const entries = asArray(value.entries).map(asRecord);
  const checkpoints = asArray(value.checkpoints).map(asRecord);
  return (
    <div className="flex flex-col gap-3">
      {checkpoints.length > 0 && (
        <ToolSection label="Checkpoints" count={checkpoints.length}>
          <ul className="flex flex-col">
            {checkpoints.map((checkpoint, index) => (
              <li key={asString(checkpoint.id) ?? index} className="flex min-w-0 items-baseline gap-2 text-xs">
                <Flag className="text-muted mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{asString(checkpoint.label) ?? asString(checkpoint.id) ?? "checkpoint"}</span>
                <span className="text-faint ms-auto shrink-0 font-mono text-[10px]">
                  {formatClock(asNumber(checkpoint.time)) ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </ToolSection>
      )}
      <ToolSection label="Changes" count={entries.length}>
        {entries.length === 0 ? (
          <p className="text-faint text-xs">No journaled writes yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {entries.slice(0, 100).map((entry, index) => (
              <li key={asNumber(entry.seq) ?? index} className="flex min-w-0 items-baseline gap-2 text-xs">
                <ToolChip>{asString(entry.kind) ?? "write"}</ToolChip>
                <span className="truncate font-mono" title={asString(entry.path)}>
                  {asString(entry.path) ?? ""}
                </span>
                <span className="text-faint ms-auto shrink-0 font-mono text-[10px]">
                  {formatClock(asNumber(entry.time)) ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ToolSection>
    </div>
  );
}

/* ------------------------------------------------------- preview and check -- */

/**
 * A file the model opened, with a one-click re-open. The button re-presents the
 * path rather than calling `openWorkspace`: a user open is a no-op when the
 * same path is already active, so a panel the user had closed would not come
 * back. Presenting always bumps the revision, which both reveals the File panel
 * and reloads the viewer.
 */
function PreviewFileCard({ path }: { path: string }) {
  return (
    <div
      data-slot="tool-preview-card"
      className="border-rule bg-surface flex items-center gap-2.5 rounded-sm border px-2 py-1.5"
    >
      <FileText className="text-muted size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-xs font-medium" title={path}>
          {basename(path)}
        </span>
        <span className="text-faint truncate font-mono text-[10px]" title={path}>
          {path}
        </span>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="shrink-0"
        onClick={() => useFileViewStore.getState().presentWorkspace(path)}
      >
        <Eye />
        Open
      </Button>
    </div>
  );
}

function previewDetail({ args, envelope }: ToolDetailProps) {
  const value = asRecord(envelope?.value);
  const path = asString(value.path) ?? asString(args.path);
  // A failed call must not offer an Open button for a file that will not open.
  if (path === undefined || (envelope !== null && !envelope.ok)) return null;
  const diagnostics = asRecord(value.diagnostics);
  const errors = asArray(diagnostics.errors).map(asRecord);
  const warnings = asArray(diagnostics.warnings).map(asRecord);
  return (
    <div className="flex flex-col gap-2">
      <PreviewFileCard path={path} />
      {envelope?.ok &&
        (errors.length === 0 && warnings.length === 0 ? (
          <p className="text-positive flex items-center gap-1.5 text-xs">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            No static issues found.
          </p>
        ) : (
          <ToolSection label="Diagnostics" count={errors.length + warnings.length}>
            <ul className="flex flex-col gap-1">
              {[
                ...errors.map((entry) => ({ entry, tone: "danger" as const })),
                ...warnings.map((entry) => ({ entry, tone: "caution" as const })),
              ].map(({ entry, tone }, index) => (
                <li key={index} className="flex min-w-0 items-baseline gap-2 text-xs">
                  <ToolChip tone={tone}>{tone === "danger" ? "error" : "warn"}</ToolChip>
                  {asNumber(entry.line) !== undefined && (
                    <span className="text-faint font-mono text-[10px]">
                      line {asNumber(entry.line)}
                    </span>
                  )}
                  <span className="min-w-0 leading-relaxed text-foreground/90">
                    {asString(entry.message) ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </ToolSection>
        ))}
    </div>
  );
}

function checkDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const errors = asArray(value.errors).map(asRecord);
  const warnings = asArray(value.warnings).map(asRecord);
  const clean = value.ok === true;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone={clean ? "positive" : "danger"}>
          {clean ? "clean" : "issues"}
        </ToolChip>
        <span className="text-faint font-mono text-[10px]">
          {asString(value.kind) ?? ""}
        </span>
      </div>
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="flex flex-col gap-1">
          {[
            ...errors.map((entry) => ({ entry, tone: "danger" as const })),
            ...warnings.map((entry) => ({ entry, tone: "caution" as const })),
          ].map(({ entry, tone }, index) => (
            <li key={index} className="flex min-w-0 items-baseline gap-2 text-xs">
              <ToolChip tone={tone}>{tone === "danger" ? "error" : "warn"}</ToolChip>
              {asNumber(entry.line) !== undefined && (
                <span className="text-faint font-mono text-[10px]">
                  line {asNumber(entry.line)}
                </span>
              )}
              <span className="min-w-0 leading-relaxed text-foreground/90">
                {asString(entry.message) ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ specs -- */

function readToolGuideDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const guide = asString(value.guide);
  if (guide !== undefined) {
    const covers = asArray(value.covers).filter(
      (item): item is string => typeof item === "string",
    );
    return (
      <div className="flex flex-col gap-2">
        {covers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {covers.map((name) => (
              <ToolChip key={name}>{name}</ToolChip>
            ))}
          </div>
        )}
        <ToolCode text={guide} limit={600} />
      </div>
    );
  }
  const topics = asArray(value.topics).map(asRecord);
  return (
    <ul className="flex flex-col gap-1.5">
      {topics.map((topic, index) => (
        <li key={asString(topic.topic) ?? index} className="flex flex-col gap-0.5">
          <span className="text-foreground/90 font-mono text-xs">
            {asString(topic.topic) ?? ""}
          </span>
          <span className="text-muted text-xs leading-relaxed">
            {asString(topic.summary) ?? ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const workspaceViews = {
  list_dir: {
    icon: FolderTree,
    label: (args) => `Listed ${args.path ? basename(asString(args.path)) : "the workspace root"}`,
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).entries).length, "entry", "entries") : undefined,
    Detail: listDirDetail,
  },
  read_file: {
    icon: FileText,
    label: (args) => `Read ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      const returned = asNumber(value.returnedLines) ?? 0;
      const total = asNumber(value.totalLines);
      return total !== undefined ? `${returned} of ${total} lines` : undefined;
    },
    Detail: readFileDetail,
  },
  write_file: {
    icon: FilePlus2,
    label: (args) => `Wrote ${basename(asString(args.path))}`,
    meta: (_args, envelope) =>
      envelope?.ok ? formatBytes(asNumber(asRecord(envelope.value).bytes)) : undefined,
    Detail: writeFileDetail,
  },
  make_dir: {
    icon: FolderPlus,
    label: (args) => `Created ${asString(args.path) ?? "a folder"}`,
    Detail: pathOnlyDetail,
  },
  remove: {
    icon: Trash2,
    label: (args) => `Removed ${asString(args.path) ?? "a path"}`,
    Detail: pathOnlyDetail,
  },
  stat: {
    icon: Info,
    label: (args) => `Inspected ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      return `${asString(value.kind) ?? "unknown"} · ${formatBytes(asNumber(value.size))}`;
    },
    Detail: statDetail,
  },
  file_info: {
    icon: FileSearch,
    label: (args) => `File info ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      return formatBytes(asNumber(asRecord(envelope.value).size));
    },
    Detail: fileInfoDetail,
  },
  edit_file: {
    icon: FileDiff,
    label: (args) => `Edited ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      if (value.applied !== true) return "no change";
      const replacements = asNumber(value.replacements) ?? 0;
      return pluralize(replacements, "replacement");
    },
    Detail: editFileDetail,
  },
  search: {
    icon: Search,
    label: (args) => `Searched ${asString(args.pattern) ? `"${asString(args.pattern)}"` : "the workspace"}`,
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(readHits(asRecord(envelope.value)).length, "hit") : undefined,
    Detail: searchDetail,
  },
  find_lines: {
    icon: TextSearch,
    label: (args) => `Found ${asString(args.pattern) ? `"${asString(args.pattern)}"` : "matches"} in ${basename(asString(args.path))}`,
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(readHits(asRecord(envelope.value)).length, "hit") : undefined,
    Detail: findLinesDetail,
  },
  move: {
    icon: FolderInput,
    label: (args) => `Moved ${basename(asString(args.from))} to ${basename(asString(args.to))}`,
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).kind) ?? undefined : undefined,
    Detail: transferDetail,
  },
  copy: {
    icon: Copy,
    label: (args) => `Copied ${basename(asString(args.from))} to ${basename(asString(args.to))}`,
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).kind) ?? undefined : undefined,
    Detail: transferDetail,
  },
  checkpoint: {
    icon: Flag,
    label: (args) => `Checkpoint${asString(args.label) ? `: ${asString(args.label)}` : ""}`,
    meta: (_args, envelope) =>
      envelope?.ok ? formatClock(asNumber(asRecord(envelope.value).time)) : undefined,
    Detail: checkpointDetail,
  },
  restore: {
    icon: History,
    label: () => "Restored a checkpoint",
    Detail: restoreDetail,
  },
  diff: {
    icon: GitCompare,
    label: (args) => `Diff ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      return `+${asNumber(value.addedLines) ?? 0} -${asNumber(value.removedLines) ?? 0}`;
    },
    Detail: diffDetail,
  },
  history: {
    icon: ScrollText,
    label: () => "Journal history",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).entries).length, "change") : undefined,
    Detail: historyDetail,
  },
  open_preview: {
    icon: Eye,
    label: (args) => `Opened ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const diagnostics = asRecord(asRecord(envelope.value).diagnostics);
      const count = asArray(diagnostics.errors).length + asArray(diagnostics.warnings).length;
      return count === 0 ? "no issues" : pluralize(count, "issue");
    },
    // The model opened this file for the user to look at, so surface the card
    // at once instead of behind a disclosure.
    autoOpen: (_args, envelope) => envelope?.ok === true,
    Detail: previewDetail,
  },
  check: {
    icon: ShieldCheck,
    label: (args) => `Checked ${basename(asString(args.path))}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      return asRecord(envelope.value).ok === true ? "clean" : "issues";
    },
    Detail: checkDetail,
  },
  read_tool_guide: {
    icon: BookOpen,
    label: (args) => (asString(args.topic) ? `Read guide: ${asString(args.topic)}` : "Read tool guides"),
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      return asArray(value.topics).length > 0 ? pluralize(asArray(value.topics).length, "topic") : undefined;
    },
    Detail: readToolGuideDetail,
  },
} satisfies Record<string, ToolViewSpec>;
