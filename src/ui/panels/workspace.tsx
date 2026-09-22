import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useWorkspaceStore } from "../../session/workspace-state";
import {
  WorkspaceConflictError,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspacePermissionError,
} from "../../workspace/errors";
import type { WorkspaceFs } from "../../workspace/fs";
import { isPickerAvailable } from "../../workspace/handle";
import type { TreeNode } from "../../workspace/tree";
import {
  baseName,
  buildTreeEntries,
  flattenTree,
  joinPath,
  parentPath,
} from "../../workspace/tree";
import { Button, Input } from "../primitives";
import { fileLookFor, folderLookFor } from "./file-icon";
import { useWorkspaceTreeStore } from "./workspace-tree-state";
import {
  PATH_MIME,
  SESSION_DRAG_TOKEN,
  TOKEN_MIME,
} from "../composer-upload";
import { invalidate as invalidateMentionIndex } from "../mention-index";

const MENU_CONTENT =
  "fixed z-50 min-w-44 rounded-sm border border-rule-strong bg-surface p-1 shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)]";

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-paper-sunk disabled:pointer-events-none disabled:opacity-45";

const ROW =
  "flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-sm text-ink hover:bg-paper-sunk";

/** Upper bound for the menu's own width, used to keep it inside the viewport. */
const MENU_WIDTH = 176;

function messageOf(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message;
  if (error instanceof Error) return error.message;
  return "The workspace operation failed.";
}

/**
 * One inline name field, used for both rename and create. It commits on Enter
 * or blur and cancels on Escape, and it only ever fires once: an Enter that is
 * immediately followed by an unmount-triggered blur must not commit twice.
 */
function InlineEdit({
  initial,
  depth,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  depth: number;
  placeholder: string;
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <li>
      <Input
        size="sm"
        autoFocus
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className="font-mono"
        style={{ marginLeft: `${depth * 12 + 4}px` }}
      />
    </li>
  );
}

function MenuItem({
  icon,
  tone = "default",
  disabled,
  onSelect,
  children,
}: {
  icon: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={`${MENU_ITEM} ${
        tone === "danger"
          ? "text-danger hover:bg-danger-soft"
          : ""
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function WorkspaceTree({
  fs,
  onOpenFile,
}: {
  fs: WorkspaceFs;
  onOpenFile(path: string): void;
}) {
  const markDenied = useWorkspaceStore((s) => s.markDenied);
  const source = useWorkspaceTreeStore((s) => s.source);
  const rootNodes = useWorkspaceTreeStore((s) => s.rootNodes);
  const children = useWorkspaceTreeStore((s) => s.children);
  const expanded = useWorkspaceTreeStore((s) => s.expanded);
  const setRoot = useWorkspaceTreeStore((s) => s.setRoot);
  const cacheChildren = useWorkspaceTreeStore((s) => s.cacheChildren);
  const expand = useWorkspaceTreeStore((s) => s.expand);
  const collapse = useWorkspaceTreeStore((s) => s.collapse);
  const invalidateSubtree = useWorkspaceTreeStore((s) => s.invalidateSubtree);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(
    null,
  );
  const [creating, setCreating] = useState<{
    dir: string;
    kind: "file" | "directory";
    value: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [menu, setMenu] = useState<{
    target: TreeNode | null;
    x: number;
    y: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const folderName = useWorkspaceStore((s) => s.folderName);

  // The cached tree belongs to one folder; until the roots for this one land,
  // the previous folder's nodes must not be drawn.
  const ready = source === fs;

  const report = useCallback(
    (cause: unknown) => {
      if (cause instanceof WorkspacePermissionError) markDenied(cause.message);
      setError(messageOf(cause));
    },
    [markDenied],
  );

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fs.list("");
        if (!cancelled) setRoot(fs, buildTreeEntries(entries, ""));
      } catch (cause) {
        if (!cancelled) report(cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, ready, setRoot, report]);

  const toggle = async (node: TreeNode) => {
    if (node.kind === "file") {
      onOpenFile(node.path);
      return;
    }
    if (expanded.has(node.path)) {
      collapse(node.path);
      return;
    }
    if (!children.has(node.path)) {
      setLoading((prev) => new Set(prev).add(node.path));
      try {
        const entries = await fs.list(node.path);
        cacheChildren(node.path, buildTreeEntries(entries, node.path));
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
    expand(node.path);
  };

  // Re-lists one directory level in place. Every mutation below touches at most
  // a source and a destination directory, so only those reload.
  const reloadDir = useCallback(
    async (dir: string) => {
      const entries = await fs.list(dir);
      const nodes = buildTreeEntries(entries, dir);
      if (dir === "") setRoot(fs, nodes);
      else cacheChildren(dir, nodes);
    },
    [fs, setRoot, cacheChildren],
  );

  const run = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fs.ensurePermission("readwrite");
        await action();
        invalidateMentionIndex(fs);
        return true;
      } catch (cause) {
        report(cause);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fs, report],
  );

  // A click anywhere but the menu, a scroll, a resize, or Escape dismisses it.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const openMenu = (
    event: ReactMouseEvent<HTMLElement>,
    target: TreeNode | null,
  ) => {
    event.preventDefault();
    setMenu({
      target,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 148)),
    });
  };

  const beginRename = (node: TreeNode) => {
    setError(null);
    setCreating(null);
    setEditing({ path: node.path, value: node.name });
  };

  const beginCreate = (dir: string, kind: "file" | "directory") => {
    setError(null);
    setEditing(null);
    setCreating({ dir, kind, value: "" });
    if (dir !== "" && !expanded.has(dir)) expand(dir);
  };

  const commitRename = () => {
    const current = editing;
    if (!current) return;
    setEditing(null);
    const name = current.value.trim();
    if (name === "" || name === baseName(current.path)) return;
    const from = current.path;
    const parent = parentPath(from);
    void run(async () => {
      await fs.move(from, joinPath(parent, name));
      invalidateSubtree(from);
      await reloadDir(parent);
    });
  };

  const commitCreate = () => {
    const current = creating;
    if (!current) return;
    setCreating(null);
    const name = current.value.trim();
    if (name === "") return;
    const path = joinPath(current.dir, name);
    const kind = current.kind;
    void run(async () => {
      try {
        await fs.stat(path);
        throw new WorkspaceConflictError(path);
      } catch (cause) {
        if (!(cause instanceof WorkspaceNotFoundError)) throw cause;
      }
      if (kind === "directory") await fs.makeDir(path);
      else await fs.writeFile(path, "");
      await reloadDir(current.dir);
      if (kind === "file") onOpenFile(path);
    });
  };

  const confirmDelete = () => {
    const node = pendingDelete;
    if (!node) return;
    setPendingDelete(null);
    const parent = parentPath(node.path);
    void run(async () => {
      await fs.remove(node.path);
      invalidateSubtree(node.path);
      await reloadDir(parent);
    });
  };

  const handleDrop = async (event: DragEvent<HTMLElement>, dir: string) => {
    event.preventDefault();
    event.stopPropagation();
    const token = event.dataTransfer.getData(TOKEN_MIME);
    const payload = event.dataTransfer.getData(PATH_MIME);
    const from = dragPath;
    setDropTarget(null);
    setDragPath(null);
    // The tree is one page among many; only a drag that carries this session's
    // token and the exact path it announced may move a file.
    if (from === null || token !== SESSION_DRAG_TOKEN || payload !== from) return;
    const to = joinPath(dir, baseName(from));
    if (to === from) return;
    await run(async () => {
      await fs.move(from, to);
      invalidateSubtree(from);
      for (const target of new Set([parentPath(from), dir])) {
        await reloadDir(target);
      }
    });
  };

  const nodeDragOver = (event: DragEvent<HTMLButtonElement>, dir: string) => {
    if (dragPath === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(dir);
  };

  const flat = ready ? flattenTree(rootNodes, children, expanded) : [];

  // Creating acts in a directory: the target itself when it is a folder (or the
  // root when there is no target), and the enclosing folder when it is a file.
  const menuDir =
    menu === null || menu.target === null
      ? ""
      : menu.target.kind === "directory"
        ? menu.target.path
        : parentPath(menu.target.path);

  const createPlaceholder =
    creating?.kind === "directory" ? "New folder name" : "New file name";

  return (
    <div className="flex flex-col gap-1">
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      {pendingDelete ? (
        <div
          role="alertdialog"
          aria-label={`Delete ${pendingDelete.name}`}
          className="flex items-center gap-1.5 rounded-sm border border-danger-rule bg-danger-soft px-2 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-xs text-ink">
            Delete “{pendingDelete.name}”?
          </span>
          <Button size="sm" variant="danger" onClick={confirmDelete}>
            Delete
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => setPendingDelete(null)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {ready && flat.length === 0 && creating === null ? (
        <p className="px-1 text-xs text-faint">This folder is empty.</p>
      ) : null}
      <div
        onContextMenu={(event) => openMenu(event, null)}
        onDragOver={(event) => {
          if (dragPath === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget("");
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null))
            return;
          setDropTarget((prev) => (prev === "" ? null : prev));
        }}
        onDrop={(event) => void handleDrop(event, "")}
      >
        <ul>
          {creating?.dir === "" ? (
            <InlineEdit
              initial=""
              depth={0}
              placeholder={createPlaceholder}
              onCommit={commitCreate}
              onCancel={() => setCreating(null)}
            />
          ) : null}
          {flat.map((node) => {
            const isDirectory = node.kind === "directory";
            const open = isDirectory && expanded.has(node.path);
            const { Icon, className } = isDirectory
              ? folderLookFor(open)
              : fileLookFor(node.path);
            return (
              <Fragment key={node.path}>
                {editing?.path === node.path ? (
                  <InlineEdit
                    initial={node.name}
                    depth={node.depth}
                    placeholder="New name"
                    onCommit={commitRename}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <li>
                    <button
                      type="button"
                      onClick={() => void toggle(node)}
                      onContextMenu={(event) => {
                        event.stopPropagation();
                        openMenu(event, node);
                      }}
                      draggable
                      onDragStart={(event) => {
                        // The composer accepts a path only with this token, and
                        // never reads `text/plain` as one, so no other page can
                        // forge a workspace path into the chip list.
                        event.dataTransfer.setData(PATH_MIME, node.path);
                        event.dataTransfer.setData(
                          TOKEN_MIME,
                          SESSION_DRAG_TOKEN,
                        );
                        event.dataTransfer.effectAllowed = "copyMove";
                        setDragPath(node.path);
                      }}
                      onDragEnd={() => {
                        setDragPath(null);
                        setDropTarget(null);
                      }}
                      onDragOver={
                        isDirectory
                          ? (event) => nodeDragOver(event, node.path)
                          : (event) => event.stopPropagation()
                      }
                      onDragLeave={
                        isDirectory
                          ? () =>
                              setDropTarget((prev) =>
                                prev === node.path ? null : prev,
                              )
                          : undefined
                      }
                      onDrop={
                        isDirectory
                          ? (event) => void handleDrop(event, node.path)
                          : undefined
                      }
                      className={`${ROW} ${
                        dropTarget === node.path
                          ? "bg-paper-sunk ring-1 ring-inset ring-accent-rule"
                          : ""
                      }`}
                      style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                    >
                      {isDirectory ? (
                        open ? (
                          <ChevronDown size={14} strokeWidth={1.75} />
                        ) : (
                          <ChevronRight size={14} strokeWidth={1.75} />
                        )
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <Icon
                        size={14}
                        strokeWidth={1.75}
                        className={`shrink-0 ${className}`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {node.name}
                      </span>
                      {loading.has(node.path) ? (
                        <span className="text-xs text-faint">…</span>
                      ) : null}
                    </button>
                  </li>
                )}
                {creating?.dir === node.path ? (
                  <InlineEdit
                    initial=""
                    depth={node.depth + 1}
                    placeholder={createPlaceholder}
                    onCommit={commitCreate}
                    onCancel={() => setCreating(null)}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </ul>
      </div>
      {menu ? (
        <div
          role="menu"
          className={MENU_CONTENT}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p className="truncate px-2 py-1 font-mono text-[10.5px] tracking-[0.08em] text-faint">
            {menu.target ? menu.target.name : (folderName ?? "Workspace")}
          </p>
          <div className="my-1 h-px bg-rule" />
          <MenuItem
            icon={<FilePlus size={13} strokeWidth={1.75} />}
            disabled={busy}
            onSelect={() => {
              setMenu(null);
              beginCreate(menuDir, "file");
            }}
          >
            New file
          </MenuItem>
          <MenuItem
            icon={<FolderPlus size={13} strokeWidth={1.75} />}
            disabled={busy}
            onSelect={() => {
              setMenu(null);
              beginCreate(menuDir, "directory");
            }}
          >
            New folder
          </MenuItem>
          {menu.target ? (
            <>
              <MenuItem
                icon={<Pencil size={13} strokeWidth={1.75} />}
                disabled={busy}
                onSelect={() => {
                  const target = menu.target;
                  setMenu(null);
                  if (target) beginRename(target);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                tone="danger"
                icon={<Trash2 size={13} strokeWidth={1.75} />}
                disabled={busy}
                onSelect={() => {
                  const target = menu.target;
                  setMenu(null);
                  if (target) setPendingDelete(target);
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : null}
        </div>
      ) : null}
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

  const refresh = async () => {
    if (fs) {
      try {
        await fs.ensurePermission("read");
      } catch (cause) {
        useWorkspaceStore.getState().markDenied(messageOf(cause));
        return;
      }
    }
    // Refresh is the one action that means "re-read the folder", so the cached
    // tree and the `@` path index both go even though the folder itself has
    // not changed.
    useWorkspaceTreeStore.getState().reset();
    invalidateMentionIndex(fs ?? undefined);
    await restore();
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
          <WorkspaceTree fs={fs} onOpenFile={onOpenFile} />
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
