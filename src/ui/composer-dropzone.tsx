import { useCallback, useState } from "react";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import { modelSupportsVision } from "../ai/model-caps";
import { composerThreadKey, useAttachmentStore } from "../chat/attachment-store";
import { isImagePath } from "../chat/attachments";
import { useChatStore } from "../chat/store";
import { useWorkspaceStore } from "../session/workspace-state";
import { useVaultStore } from "../vault/store";
import {
  WorkspaceLimitError,
  WorkspacePermissionError,
} from "../workspace/errors";
import {
  HTML_MIME,
  MAX_DROPPED_PATHS,
  MAX_DROPPED_URLS,
  PATH_MIME,
  TOKEN_MIME,
  SESSION_DRAG_TOKEN,
  URI_LIST_MIME,
  acceptInternalPaths,
  fetchUrlIntoWorkspace,
  parseDropUrls,
  uploadFiles,
} from "./composer-upload";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The attachment could not be added.";
}

/**
 * The composer shell's drop target.
 *
 * Replaces `ComposerPrimitive.AttachmentDropzone`, which gates on
 * `thread.capabilities.attachments` and reacts only to native `Files`; this app
 * has no attachment adapter and also has to accept internal path drops from the
 * workspace tree.
 */
export function ComposerDropzone({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fs = useWorkspaceStore((s) => s.fs);
  const regrant = useWorkspaceStore((s) => s.regrant);
  const settings = useVaultStore((s) => s.settings);
  const config = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.config : undefined,
  );
  const vision = modelSupportsVision(settings, config?.providerId, config?.modelId);

  const accepts = useCallback((event: DragEvent<HTMLDivElement>): boolean => {
    const types = Array.from(event.dataTransfer.types);
    return (
      types.includes("Files") ||
      types.includes(PATH_MIME) ||
      types.includes(URI_LIST_MIME)
    );
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    [accepts],
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }, []);

  /**
   * Writes picked or pasted files into the workspace and attaches them. Shared
   * by the drop and paste entry points so both honor the same vision gate.
   */
  const uploadPickedFiles = useCallback(
    async (files: File[]) => {
      const setError = useChatStore.getState().setError;
      if (!fs) {
        setError("Choose a workspace folder before attaching files.");
        return;
      }
      const threadId = composerThreadKey();
      const allowed = vision
        ? files
        : files.filter((file) => !isImagePath(file.name));
      const blocked = files.length - allowed.length;
      try {
        if (allowed.length > 0) await uploadFiles(fs, threadId, allowed);
      } catch (error) {
        if (error instanceof WorkspacePermissionError) {
          setError(
            "The workspace folder is read-only in this session. Grant write access and try again.",
          );
          void regrant();
          return;
        }
        if (error instanceof WorkspaceLimitError) {
          setError("That file is too large to add to the workspace.");
          return;
        }
        setError(describe(error));
        return;
      }
      if (blocked > 0) {
        setError(
          `${blocked} image ${blocked === 1 ? "file was" : "files were"} skipped: the active model has no image input.`,
        );
      }
    },
    [fs, regrant, vision],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files);
      // A text paste keeps its native behavior; only an actual file is taken.
      if (files.length === 0) return;
      event.preventDefault();
      void uploadPickedFiles(files);
    },
    [uploadPickedFiles],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!accepts(event)) return;
      event.preventDefault();
      setDragging(false);
      const setError = useChatStore.getState().setError;
      if (!fs) {
        setError("Choose a workspace folder before attaching files.");
        return;
      }
      const threadId = composerThreadKey();
      const pathPayload = event.dataTransfer.getData(PATH_MIME);
      const token = event.dataTransfer.getData(TOKEN_MIME);
      const files = Array.from(event.dataTransfer.files);
      const remote =
        pathPayload === "" && files.length === 0
          ? parseDropUrls({
              uriList: event.dataTransfer.getData(URI_LIST_MIME),
              html: event.dataTransfer.getData(HTML_MIME),
            })
          : { urls: [], rejected: 0 };

      void (async () => {
        try {
          if (pathPayload !== "") {
            if (token !== SESSION_DRAG_TOKEN) {
              setError("That drag did not come from this workspace.");
              return;
            }
            const { paths, rejected } = await acceptInternalPaths(
              fs,
              pathPayload,
            );
            // A non-vision model can still take text and folder references; only
            // image paths are withheld before they become chips.
            const allowed = vision
              ? paths
              : paths.filter((path) => !isImagePath(path));
            const blocked = paths.length - allowed.length;
            for (const path of allowed) {
              const stat = await fs.stat(path);
              useAttachmentStore.getState().add(threadId, {
                kind: stat.kind === "directory" ? "folder" : "file",
                path,
                source: "drag",
                ...(stat.kind === "file" ? { bytes: stat.size } : {}),
              });
            }
            const skipped = rejected + blocked;
            if (skipped > 0) {
              setError(
                allowed.length === 0
                  ? `That drop carried no attachable path: at most ${MAX_DROPPED_PATHS} paths are accepted, each has to exist in this folder, and the active model has no image input.`
                  : `${skipped} dropped ${skipped === 1 ? "path was" : "paths were"} skipped.`,
              );
            }
            return;
          }
          if (files.length > 0) {
            await uploadPickedFiles(files);
            return;
          }
          if (remote.rejected > 0) {
            setError(
              `At most ${MAX_DROPPED_URLS} links can be fetched at once; ${remote.rejected} were dropped.`,
            );
            return;
          }
          if (remote.urls.length > 0) {
            const fetchable = vision
              ? remote.urls
              : remote.urls.filter((url) => !isImagePath(url));
            const blocked = remote.urls.length - fetchable.length;
            if (fetchable.length === 0) {
              setError(
                "Every dragged link was an image, and the active model has no image input.",
              );
              return;
            }
            setBusy(true);
            try {
              const failures: string[] = [];
              for (const url of fetchable) {
                try {
                  await fetchUrlIntoWorkspace(fs, threadId, url);
                } catch (error) {
                  // A read-only folder or a hard size cap is a workspace
                  // problem, not a per-link one; let the outer handler report it.
                  if (
                    error instanceof WorkspacePermissionError ||
                    error instanceof WorkspaceLimitError
                  ) {
                    throw error;
                  }
                  failures.push(describe(error));
                }
              }
              if (failures.length > 0) {
                setError(
                  failures.length === 1
                    ? failures[0]
                    : `${failures.length} of ${fetchable.length} links could not be fetched: ${failures[0]}`,
                );
              } else if (blocked > 0) {
                setError(
                  `${blocked} image ${blocked === 1 ? "link was" : "links were"} skipped: the active model has no image input.`,
                );
              }
            } finally {
              setBusy(false);
            }
          }
        } catch (error) {
          if (error instanceof WorkspacePermissionError) {
            setError(
              "The workspace folder is read-only in this session. Grant write access and try again.",
            );
            void regrant();
            return;
          }
          if (error instanceof WorkspaceLimitError) {
            setError("That file is too large to add to the workspace.");
            return;
          }
          setError(describe(error));
        }
      })();
    },
    [accepts, fs, regrant, uploadPickedFiles, vision],
  );

  return (
    <div
      data-slot="aui_composer-shell"
      data-dragging={dragging ? "true" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
      className="border-foreground/10 focus-within:border-foreground/25 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
    >
      {busy ? (
        <p
          data-slot="aui_composer-drop-status"
          className="text-muted-foreground px-1 text-xs"
        >
          Fetching linked file…
        </p>
      ) : null}
      {children}
    </div>
  );
}
