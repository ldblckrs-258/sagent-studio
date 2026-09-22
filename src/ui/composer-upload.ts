import { useAttachmentStore } from "../chat/attachment-store";
import type { WorkspaceFs } from "../workspace/fs";
import {
  resolveSegments,
  uniqueUploadPath,
  writeWorkspaceBlob,
} from "../workspace/fs";

/** Where every upload lands, so one attachment model covers both entry points. */
export const UPLOAD_DIRECTORY = "uploads";

/** Bound on one drop, so a page cannot flood the composer with chips. */
export const MAX_DROPPED_PATHS = 20;

/**
 * Bound on one upload batch. Writes are sequential and each one is a workspace
 * round trip, so an unbounded directory drop would block the composer for
 * minutes with no way to cancel.
 */
export const MAX_UPLOAD_FILES = 20;

/** Per-file ceiling for an upload, well under the 100 MB blob cap. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

export const PATH_MIME = "application/x-sagent-path";
export const TOKEN_MIME = "application/x-sagent-token";

/** A link or image dragged out of another page carries its URL under these. */
export const URI_LIST_MIME = "text/uri-list";
export const HTML_MIME = "text/html";

/** Bound on one link drop, so a page cannot flood the composer with fetches. */
export const MAX_DROPPED_URLS = 10;

const FETCH_TIMEOUT_MS = 30_000;

const MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

/**
 * Extension for a media type a fetched URL announces, used only when the URL
 * path carries no extension of its own. An unknown type falls through to a
 * bare name and lets `sanitizeUploadName` decide.
 */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/xml": "xml",
  "application/json": "json",
  "application/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
};

/**
 * Proof that a path drop came from this page. Any page in another tab can put
 * arbitrary text under a custom `DataTransfer` type, so the payload stays
 * attacker-controlled text until this token matches and every path validates.
 */
export const SESSION_DRAG_TOKEN = crypto.randomUUID();

/**
 * Writes picked files into the workspace and attaches them.
 *
 * Sequential by necessity: two files with the same name probed in parallel
 * would both see the name free and one would overwrite the other.
 */
export async function uploadFiles(
  fs: WorkspaceFs,
  threadId: string,
  files: readonly File[],
): Promise<void> {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new UploadRejectedError(
      `Only ${MAX_UPLOAD_FILES} files can be uploaded at once; ${files.length} were picked.`,
    );
  }
  const oversized = files.find((file) => file.size > MAX_UPLOAD_BYTES);
  if (oversized) {
    throw new UploadRejectedError(
      `"${oversized.name}" is larger than the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`,
    );
  }
  const { add } = useAttachmentStore.getState();
  for (const file of files) {
    const path = await uniqueUploadPath(fs, UPLOAD_DIRECTORY, file.name);
    await writeWorkspaceBlob(fs, path, file);
    add(threadId, {
      kind: "file",
      path,
      source: "upload",
      bytes: file.size,
    });
  }
}

function addUrl(target: string[], value: string): void {
  const trimmed = value.trim();
  // `text/uri-list` uses `#` for comments and blank lines for padding.
  if (trimmed === "" || trimmed.startsWith("#")) return;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return;
  }
  // A page can put anything under a `DataTransfer` type; only a well-formed
  // http(s) link is fetched, never `javascript:`, `data:`, or `file:`.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (!target.includes(url.href)) target.push(url.href);
}

/**
 * URLs a link drop may fetch. `text/uri-list` is authoritative; the HTML
 * fragment is the fallback for a browser that exposes only the dragged
 * `<img src>` or `<a href>`, never as a `uri-list` entry.
 */
export function parseDropUrls(payload: {
  uriList: string;
  html: string;
}): { urls: string[]; rejected: number } {
  const urls: string[] = [];
  for (const line of payload.uriList.split(/\r?\n/)) addUrl(urls, line);
  if (urls.length === 0) {
    const pattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    for (const match of payload.html.matchAll(pattern)) {
      const captured = match[1];
      if (captured !== undefined) addUrl(urls, captured);
    }
  }
  if (urls.length > MAX_DROPPED_URLS) return { urls: [], rejected: urls.length };
  return { urls, rejected: 0 };
}

/**
 * Name a fetched URL should land under: its path segment when it has an
 * extension, otherwise the segment plus an extension from the announced media
 * type. `uniqueUploadPath` sanitizes the result.
 */
export function filenameForUrl(url: string, contentType = ""): string {
  let segment = "";
  try {
    const raw = new URL(url).pathname.split("/").filter((part) => part !== "").pop() ?? "";
    try {
      segment = decodeURIComponent(raw);
    } catch {
      segment = raw;
    }
  } catch {
    // A malformed URL keeps the `download` fallback below.
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
  const dot = segment.lastIndexOf(".");
  if (dot > 0 && dot < segment.length - 1) return segment;
  if (segment === "") return extension === undefined ? "download" : `download.${extension}`;
  return extension === undefined ? segment : `${segment}.${extension}`;
}

/**
 * Fetches a URL dragged out of another page and writes it into the workspace
 * like any other upload.
 *
 * Cross-origin by necessity, so a site that sends no CORS headers fails here
 * with a message rather than a silent no-op. `credentials: "omit"` keeps the
 * user's cookies on the dragged origin out of the request.
 */
export async function fetchUrlIntoWorkspace(
  fs: WorkspaceFs,
  threadId: string,
  url: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw string for the message.
  }
  const request = options.fetchImpl ?? fetch;
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  let response: Response;
  try {
    response = await request(url, { mode: "cors", credentials: "omit", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new UploadRejectedError(`"${host}" took too long to respond.`);
    }
    throw new UploadRejectedError(
      `"${host}" could not be fetched; the site may block cross-origin downloads.`,
    );
  }
  if (!response.ok) {
    throw new UploadRejectedError(`"${host}" refused the download (HTTP ${response.status}).`);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError(`"${host}" is larger than the ${MB} MB upload limit.`);
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new UploadRejectedError(`"${host}" came back empty.`);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError(`"${host}" is larger than the ${MB} MB upload limit.`);
  }
  const path = await uniqueUploadPath(fs, UPLOAD_DIRECTORY, filenameForUrl(url, blob.type));
  await writeWorkspaceBlob(fs, path, blob, { maxBytes: MAX_UPLOAD_BYTES });
  useAttachmentStore.getState().add(threadId, {
    kind: "file",
    path,
    source: "drag",
    bytes: blob.size,
  });
}

/**
 * Paths a drop may attach: this session's token has to be present, the list is
 * capped, and every entry has to resolve and exist. `text/plain` is never read
 * as a path.
 */
export async function acceptInternalPaths(
  fs: WorkspaceFs,
  payload: string,
): Promise<{ paths: string[]; rejected: number }> {
  const candidates = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (candidates.length > MAX_DROPPED_PATHS) {
    return { paths: [], rejected: candidates.length };
  }
  const paths: string[] = [];
  let rejected = 0;
  for (const candidate of candidates) {
    try {
      resolveSegments(candidate);
      await fs.stat(candidate);
      paths.push(candidate);
    } catch {
      rejected += 1;
    }
  }
  return { paths, rejected };
}

