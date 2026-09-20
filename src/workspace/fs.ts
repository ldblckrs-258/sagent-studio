import type {
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceStat,
  WorkspaceTransferResult,
} from "../tools/types";
import {
  WorkspaceConflictError,
  WorkspaceInvalidInputError,
  WorkspaceLimitError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspacePermissionError,
} from "./errors";
import { compileGlob } from "./glob";
import type { SearchRunner } from "./search-runner";
import { createSearchRunner } from "./search-runner";

export {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES_SCANNED,
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_HIT_CHARS,
  MAX_SEARCH_RESULTS,
} from "./search";

declare global {
  interface FileSystemHandle {
    queryPermission?(descriptor?: {
      mode?: "read" | "readwrite";
    }): Promise<PermissionState>;
    requestPermission?(descriptor?: {
      mode?: "read" | "readwrite";
    }): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<
      FileSystemDirectoryHandle | FileSystemFileHandle
    >;
  }
  interface Window {
    showDirectoryPicker?(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
}

export const DEFAULT_SIZE_CAP = 2 * 1024 * 1024;

/**
 * Media and document previews are read as blobs, not decoded text, so they get a
 * separate ceiling from the text editor's `DEFAULT_SIZE_CAP`.
 */
export const DEFAULT_BINARY_SIZE_CAP = 100 * 1024 * 1024;

export const DEFAULT_RECURSIVE_MAX_ENTRIES = 1000;

const SEGMENT = /^[^<>:"|?*\0\\/]+$/;

export type PermissionMode = "read" | "readwrite";

export function resolveSegments(path: string): string[] {
  if (path.includes("\0")) throw new WorkspacePathError(path);
  if (path.startsWith("/") || path.startsWith("\\"))
    throw new WorkspacePathError(path);
  if (/^[a-zA-Z]:/.test(path) || path.startsWith("\\\\"))
    throw new WorkspacePathError(path);
  const segments = path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (segment === ".." || !SEGMENT.test(segment)) {
      throw new WorkspacePathError(path);
    }
  }
  return segments;
}

function mapDomError(error: unknown, path: string): never {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      throw new WorkspacePermissionError();
    }
    if (error.name === "NotFoundError") throw new WorkspaceNotFoundError(path);
  }
  throw error;
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode,
): Promise<void> {
  const query = handle.queryPermission;
  const request = handle.requestPermission;
  if (typeof query !== "function" && typeof request !== "function") return;
  try {
    if (
      typeof query === "function" &&
      (await query.call(handle, { mode })) === "granted"
    )
      return;
    if (
      typeof request === "function" &&
      (await request.call(handle, { mode })) === "granted"
    )
      return;
  } catch (error) {
    mapDomError(error, "");
  }
  throw new WorkspacePermissionError();
}

export interface WorkspaceFs {
  readonly kind: "workspace";
  readonly handle: FileSystemDirectoryHandle;
  ensurePermission(mode: PermissionMode): Promise<void>;
  list(path: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<WorkspaceStat>;
  move(from: string, to: string): Promise<WorkspaceTransferResult>;
  copy(from: string, to: string): Promise<WorkspaceTransferResult>;
  search(options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult>;
}

export interface WorkspaceFsOptions {
  sizeCap?: number;
  searchRunner?: SearchRunner;
}

function isSameOrDescendant(
  ancestor: readonly string[],
  candidate: readonly string[],
): boolean {
  if (candidate.length < ancestor.length) return false;
  for (let index = 0; index < ancestor.length; index += 1) {
    if (ancestor[index] !== candidate[index]) return false;
  }
  return true;
}

class FileWorkspaceFs implements WorkspaceFs {
  readonly kind = "workspace" as const;
  readonly handle: FileSystemDirectoryHandle;
  private readonly sizeCap: number;
  private readonly searchRunner: SearchRunner;

  constructor(
    handle: FileSystemDirectoryHandle,
    sizeCap: number,
    searchRunner?: SearchRunner,
  ) {
    this.handle = handle;
    this.sizeCap = sizeCap;
    this.searchRunner = searchRunner ?? createSearchRunner({ workspace: this });
  }

  async ensurePermission(mode: PermissionMode): Promise<void> {
    await ensurePermission(this.handle, mode);
  }

  private async directoryFor(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    await this.ensurePermission(create ? "readwrite" : "read");
    let directory = this.handle;
    try {
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create });
      }
    } catch (error) {
      mapDomError(error, segments.join("/"));
    }
    return directory;
  }

  private async fileFor(
    path: string,
    segments: string[],
  ): Promise<{ file: File; parent: FileSystemDirectoryHandle; name: string }> {
    if (segments.length === 0) throw new WorkspacePathError(path);
    const parent = await this.directoryFor(segments.slice(0, -1), false);
    const name = segments[segments.length - 1];
    try {
      const handle = await parent.getFileHandle(name);
      return { file: await handle.getFile(), parent, name };
    } catch (error) {
      mapDomError(error, segments.join("/"));
    }
  }

  async list(
    path: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceEntry[]> {
    const segments = resolveSegments(path);
    const directory = await this.directoryFor(segments, false);
    const recursive = options.recursive === true;
    const matcher =
      options.glob === undefined ? null : compileGlob(options.glob);
    const maxEntries =
      options.maxEntries ??
      (recursive ? DEFAULT_RECURSIVE_MAX_ENTRIES : undefined);
    const entries: WorkspaceEntry[] = [];
    const start = segments.join("/");
    let stopped = false;

    const visit = async (
      dir: FileSystemDirectoryHandle,
      prefix: string,
    ): Promise<void> => {
      const children: Array<FileSystemDirectoryHandle | FileSystemFileHandle> =
        [];
      try {
        for await (const child of dir.values()) children.push(child);
      } catch (error) {
        mapDomError(error, prefix);
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (stopped) return;
        const childPath =
          prefix === "" ? child.name : `${prefix}/${child.name}`;
        const matches = matcher === null || matcher.test(childPath);
        if (matches) {
          if (maxEntries !== undefined && entries.length >= maxEntries) {
            stopped = true;
            return;
          }
          entries.push({ name: child.name, path: childPath, kind: child.kind });
        }
        if (recursive && child.kind === "directory") {
          await visit(child as FileSystemDirectoryHandle, childPath);
        }
      }
    };

    await visit(directory, start);
    if (!recursive) entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async readFile(path: string): Promise<string> {
    const { file } = await this.fileFor(path, resolveSegments(path));
    if (file.size > this.sizeCap) throw new WorkspaceLimitError(path);
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > this.sizeCap) {
      throw new WorkspaceLimitError(path);
    }
    return text;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > this.sizeCap) throw new WorkspaceLimitError(path);
    const segments = resolveSegments(path);
    if (segments.length === 0) throw new WorkspacePathError(path);
    const parent = await this.directoryFor(segments.slice(0, -1), true);
    const name = segments[segments.length - 1];
    try {
      const handle = await parent.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    } catch (error) {
      mapDomError(error, path);
    }
  }

  async makeDir(path: string): Promise<void> {
    const segments = resolveSegments(path);
    if (segments.length === 0) throw new WorkspacePathError(path);
    await this.directoryFor(segments, true);
  }

  async remove(path: string): Promise<void> {
    const segments = resolveSegments(path);
    if (segments.length === 0) throw new WorkspacePathError(path);
    const parent = await this.directoryFor(segments.slice(0, -1), false);
    const name = segments[segments.length - 1];
    try {
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      mapDomError(error, path);
    }
  }

  async stat(path: string): Promise<WorkspaceStat> {
    const segments = resolveSegments(path);
    await this.ensurePermission("read");
    if (segments.length === 0) return { path: "", kind: "directory", size: 0 };
    const parent = await this.directoryFor(segments.slice(0, -1), false);
    const name = segments[segments.length - 1];
    try {
      const handle = await parent.getFileHandle(name);
      const file = await handle.getFile();
      return {
        path,
        kind: "file",
        size: file.size,
        ...(typeof file.lastModified === "number"
          ? { lastModified: file.lastModified }
          : {}),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "TypeMismatchError") {
        return { path, kind: "directory", size: 0 };
      }
      mapDomError(error, path);
    }
  }

  private async statOptional(path: string): Promise<WorkspaceStat | null> {
    try {
      return await this.stat(path);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) return null;
      throw error;
    }
  }

  private async copyFilePrimitive(
    source: FileSystemFileHandle,
    toSegments: string[],
  ): Promise<void> {
    const parent = await this.directoryFor(toSegments.slice(0, -1), true);
    const name = toSegments[toSegments.length - 1];
    try {
      const destination = await parent.getFileHandle(name, { create: true });
      const buffer = await (await source.getFile()).arrayBuffer();
      const writable = await destination.createWritable();
      await writable.write(buffer);
      await writable.close();
    } catch (error) {
      mapDomError(error, toSegments.join("/"));
    }
  }

  private async copyDirectory(
    source: FileSystemDirectoryHandle,
    toSegments: string[],
  ): Promise<void> {
    await this.directoryFor(toSegments, true);
    const children: Array<FileSystemDirectoryHandle | FileSystemFileHandle> =
      [];
    try {
      for await (const child of source.values()) children.push(child);
    } catch (error) {
      mapDomError(error, toSegments.join("/"));
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const nextSegments = [...toSegments, child.name];
      if (child.kind === "directory") {
        await this.copyDirectory(
          child as FileSystemDirectoryHandle,
          nextSegments,
        );
      } else {
        await this.copyFilePrimitive(
          child as FileSystemFileHandle,
          nextSegments,
        );
      }
    }
  }

  private async transfer(
    from: string,
    to: string,
  ): Promise<{
    from: string;
    to: string;
    kind: "file" | "directory";
    size: number;
  }> {
    const fromSegments = resolveSegments(from);
    const toSegments = resolveSegments(to);
    if (fromSegments.length === 0 || toSegments.length === 0) {
      throw new WorkspacePathError(fromSegments.length === 0 ? from : to);
    }
    if (isSameOrDescendant(fromSegments, toSegments)) {
      throw new WorkspaceInvalidInputError(
        `The destination "${to}" must not be the source "${from}" or a descendant of it.`,
      );
    }

    await this.ensurePermission("readwrite");
    const source = await this.stat(from);

    const destination = await this.statOptional(to);
    if (destination !== null) throw new WorkspaceConflictError(to);

    if (source.kind === "file") {
      await this.copyFilePrimitive(
        await this.fileHandleFor(fromSegments),
        toSegments,
      );
    } else {
      const directory = await this.directoryFor(fromSegments, false);
      await this.copyDirectory(directory, toSegments);
    }

    return { from, to, kind: source.kind, size: source.size };
  }

  private async fileHandleFor(
    segments: string[],
  ): Promise<FileSystemFileHandle> {
    const parent = await this.directoryFor(segments.slice(0, -1), false);
    const name = segments[segments.length - 1];
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      mapDomError(error, segments.join("/"));
    }
  }

  async copy(from: string, to: string): Promise<WorkspaceTransferResult> {
    return this.transfer(from, to);
  }

  async move(from: string, to: string): Promise<WorkspaceTransferResult> {
    const result = await this.transfer(from, to);
    await this.remove(from);
    return result;
  }

  async search(
    options: WorkspaceSearchOptions,
  ): Promise<WorkspaceSearchResult> {
    return this.searchRunner.search(options);
  }
}

/**
 * Reads a workspace file as a `Blob` without decoding it. Used by binary
 * previews (images, media, DOCX, spreadsheets); text flows through
 * `WorkspaceFs.readFile` and its smaller cap instead. Kept as a function rather
 * than an interface member so existing `WorkspaceFs` mocks stay valid.
 */
export async function readWorkspaceBlob(
  fs: WorkspaceFs,
  path: string,
  options: { maxBytes?: number } = {},
): Promise<Blob> {
  const segments = resolveSegments(path);
  if (segments.length === 0) throw new WorkspacePathError(path);
  await fs.ensurePermission("read");
  try {
    let directory = fs.handle;
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment);
    }
    const handle = await directory.getFileHandle(segments[segments.length - 1]);
    const file = await handle.getFile();
    const cap = options.maxBytes ?? DEFAULT_BINARY_SIZE_CAP;
    if (file.size > cap) throw new WorkspaceLimitError(path);
    return file;
  } catch (error) {
    mapDomError(error, segments.join("/"));
  }
}

export function createWorkspaceFs(
  handle: FileSystemDirectoryHandle,
  options: WorkspaceFsOptions = {},
): WorkspaceFs {
  return new FileWorkspaceFs(
    handle,
    options.sizeCap ?? DEFAULT_SIZE_CAP,
    options.searchRunner,
  );
}
