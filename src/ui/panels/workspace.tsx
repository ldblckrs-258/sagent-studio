import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useWorkspaceStore } from "../../session/workspace-state";
import {
  WorkspaceError,
  WorkspacePermissionError,
} from "../../workspace/errors";
import type { WorkspaceFs } from "../../workspace/fs";
import { isPickerAvailable } from "../../workspace/handle";
import type { TreeNode } from "../../workspace/tree";
import { buildTreeEntries, flattenTree } from "../../workspace/tree";
import { Button } from "../primitives";

function messageOf(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message;
  if (error instanceof Error) return error.message;
  return "The workspace operation failed.";
}

function WorkspaceTree({
  fs,
  onOpenFile,
}: {
  fs: WorkspaceFs;
  onOpenFile(path: string): void;
}) {
  const markDenied = useWorkspaceStore((s) => s.markDenied);
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [children, setChildren] = useState<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(
    (cause: unknown) => {
      if (cause instanceof WorkspacePermissionError) markDenied(cause.message);
      setError(messageOf(cause));
    },
    [markDenied],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fs.list("");
        if (!cancelled) setRootNodes(buildTreeEntries(entries, ""));
      } catch (cause) {
        if (!cancelled) report(cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, report]);

  const toggle = async (node: TreeNode) => {
    if (node.kind === "file") {
      onOpenFile(node.path);
      return;
    }
    if (expanded.has(node.path)) {
      const next = new Set(expanded);
      next.delete(node.path);
      setExpanded(next);
      return;
    }
    if (!children.has(node.path)) {
      setLoading((prev) => new Set(prev).add(node.path));
      try {
        const entries = await fs.list(node.path);
        setChildren((prev) =>
          new Map(prev).set(node.path, buildTreeEntries(entries, node.path)),
        );
      } catch (cause) {
        report(cause);
        return;
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(node.path);
          return next;
        });
      }
    }
    setExpanded((prev) => new Set(prev).add(node.path));
  };

  const flat = flattenTree(rootNodes, children, expanded);

  return (
    <div className="flex flex-col gap-1">
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      {flat.length === 0 ? (
        <p className="px-1 text-xs text-faint">This folder is empty.</p>
      ) : null}
      <ul>
        {flat.map((node) => (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => void toggle(node)}
              className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-sm text-ink hover:bg-paper-sunk"
              style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
            >
              {node.kind === "directory" ? (
                <>
                  {expanded.has(node.path) ? (
                    <ChevronDown size={14} strokeWidth={1.75} />
                  ) : (
                    <ChevronRight size={14} strokeWidth={1.75} />
                  )}
                  <Folder size={14} strokeWidth={1.75} />
                </>
              ) : (
                <>
                  <span className="w-3.5" />
                  <FileIcon size={14} strokeWidth={1.75} />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {loading.has(node.path) ? (
                <span className="text-xs text-faint">…</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkspacePanel({
  onOpenFile,
}: {
  onOpenFile(path: string): void;
}) {
  const fs = useWorkspaceStore((s) => s.fs);
  const folderName = useWorkspaceStore((s) => s.folderName);
  const status = useWorkspaceStore((s) => s.status);
  const error = useWorkspaceStore((s) => s.error);
  const pick = useWorkspaceStore((s) => s.pick);
  const regrant = useWorkspaceStore((s) => s.regrant);
  const restore = useWorkspaceStore((s) => s.restore);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = async () => {
    if (fs) {
      try {
        await fs.ensurePermission("read");
      } catch (cause) {
        useWorkspaceStore.getState().markDenied(messageOf(cause));
        return;
      }
    }
    await restore();
    setReloadKey((key) => key + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex flex-col gap-1.5 rounded-sm border border-rule bg-surface p-2">
        <div className="flex gap-1.5 justify-between">
          <div>
            <span className="label-micro">Folder</span>
            <p className="truncate text-sm text-ink">
              {folderName ?? "No folder chosen"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            {fs ? (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => void refresh()}
                icon={<RefreshCw size={14} strokeWidth={1.75} />}
              >
                Refresh
              </Button>
            ) : null}
            {status === "denied" && fs ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void regrant()}
              >
                Grant access
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!isPickerAvailable()}
              onClick={() => void pick()}
            >
              {folderName ? "Change folder" : "Choose folder"}
            </Button>
          </div>
        </div>
        {status === "unsupported" ? (
          <p role="alert" className="font-mono text-xs text-caution">
            {error}
          </p>
        ) : null}
        {status === "denied" && error ? (
          <p role="alert" className="font-mono text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {fs && status !== "denied" ? (
          <WorkspaceTree
            key={`${folderName}-${reloadKey}`}
            fs={fs}
            onOpenFile={onOpenFile}
          />
        ) : (
          <p className="px-1 text-xs text-faint">
            {status === "denied"
              ? "Grant access to browse the folder."
              : "Choose a folder to browse."}
          </p>
        )}
      </div>
    </div>
  );
}
