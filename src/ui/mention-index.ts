import { isDenied } from "../chat/attachments";
import type { WorkspaceFs } from "../workspace/fs";
import { DEFAULT_RECURSIVE_MAX_ENTRIES } from "../workspace/fs";
import { DEFAULT_EXCLUDED_DIRS } from "../workspace/search";

export type MentionEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
};

export type MentionIndex = {
  entries: MentionEntry[];
  /** True when `fs.list` stopped at its recursive cap. */
  truncated: boolean;
};

const EXCLUDED = new Set(DEFAULT_EXCLUDED_DIRS);

/** OS bookkeeping files: never what a mention means. */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Walk options shared by the index and its glob fallback. */
const WALK = {
  recursive: true as const,
  excludeDirs: DEFAULT_EXCLUDED_DIRS,
  excludeDotDirs: true as const,
};

/** Fallback matches asked for by name when the cached index came back capped. */
export const FALLBACK_MAX_ENTRIES = 50;

export function keepEntry(path: string, kind: "file" | "directory"): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? path;
  if (segments.slice(0, -1).some((segment) => EXCLUDED.has(segment) || segment.startsWith("."))) {
    return false;
  }
  if (EXCLUDED.has(name)) return false;
  if (kind === "directory" && name.startsWith(".")) return false;
  if (JUNK_NAMES.has(name)) return false;
  return !isDenied(path);
}

/**
 * Entries of one directory, listed on demand.
 *
 * The cached index deliberately skips dot-directories and vendor trees, which
 * would otherwise crowd out everything a mention usually means. A query that
 * names one explicitly — `@.opencode/`, or `@.o` at the root — is not that
 * case: the user has already said which folder they want, so it is listed
 * directly instead of being filtered out of a listing they never see.
 */
export function directoryEntries(
  fs: WorkspaceFs,
  directory: string,
): Promise<MentionEntry[]> {
  const perFs = dirCache.get(fs) ?? new Map<string, Promise<MentionEntry[]>>();
  dirCache.set(fs, perFs);
  const cached = perFs.get(directory);
  if (cached) return cached;
  const pending = fs
    .list(directory)
    .then((listed) =>
      listed
        .filter((entry) => !isDenied(entry.path) && !JUNK_NAMES.has(entry.name))
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          kind: entry.kind,
        })),
    )
    .catch((error: unknown) => {
      perFs.delete(directory);
      throw error;
    });
  perFs.set(directory, pending);
  return pending;
}

/**
 * The directory a query is browsing, or null when it is a plain search of the
 * index. A query with a slash browses its parent; a query that starts a
 * hidden name browses the root, which is what makes `.opencode` reachable.
 */
export function scopeOfQuery(query: string): string | null {
  const slash = query.lastIndexOf("/");
  if (slash !== -1) return query.slice(0, slash);
  return query.startsWith(".") ? "" : null;
}

const cache = new WeakMap<WorkspaceFs, Promise<MentionIndex>>();
const dirCache = new WeakMap<WorkspaceFs, Map<string, Promise<MentionEntry[]>>>();

async function build(fs: WorkspaceFs): Promise<MentionIndex> {
  // Excluded while walking, not after: the 1000-entry budget is spent during
  // the walk, so a vendor tree that sorts before `src/` would otherwise leave
  // the index holding nothing a user would ever mention.
  const listed = await fs.list("", WALK);
  const entries = listed
    .filter((entry) => keepEntry(entry.path, entry.kind))
    .map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind }));
  return {
    entries,
    truncated: listed.length >= DEFAULT_RECURSIVE_MAX_ENTRIES,
  };
}

/** One index per folder, since `WorkspaceFs` identity is the folder's identity. */
export function mentionIndex(fs: WorkspaceFs): Promise<MentionIndex> {
  const cached = cache.get(fs);
  if (cached) return cached;
  const pending = build(fs).catch((error: unknown) => {
    cache.delete(fs);
    throw error;
  });
  cache.set(fs, pending);
  return pending;
}

/** Drops the cached index, for the workspace panel's refresh button. */
export function invalidate(fs?: WorkspaceFs): void {
  if (fs) {
    cache.delete(fs);
    dirCache.delete(fs);
  }
}

function subsequenceOf(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor) + 1;
    if (cursor === 0) return false;
  }
  return true;
}

function scoreOf(entry: MentionEntry, query: string): number {
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (path.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  if (subsequenceOf(path, query)) return 4;
  return Number.POSITIVE_INFINITY;
}

/**
 * Ranks by how directly the query names the entry: a basename prefix first,
 * then a path prefix, then a containment, then a subsequence, with the shorter
 * path winning a tie. An empty query keeps tree order.
 */
export function rankEntries(
  entries: readonly MentionEntry[],
  query: string,
  limit = 20,
): MentionEntry[] {
  if (query === "") return entries.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: { entry: MentionEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreOf(entry, needle);
    if (score !== Number.POSITIVE_INFINITY) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.entry.path.length !== b.entry.path.length) {
      return a.entry.path.length - b.entry.path.length;
    }
    return a.entry.path.localeCompare(b.entry.path);
  });
  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * Names outside the cached index, asked for by glob.
 *
 * `fs.search` matches file **content** and compiles its pattern as a live
 * RegExp, so it cannot answer "which paths are called this"; `fs.list` already
 * compiles a glob against the path.
 */
export async function searchByName(
  fs: WorkspaceFs,
  query: string,
): Promise<MentionEntry[]> {
  // `compileGlob` keeps `*` and `?` as wildcards, so a query of repeated `*`
  // would compile to a chain of `.*` and backtrack over the whole tree.
  const literal = query.replace(/[*?]/g, "");
  if (literal === "") return [];
  const listed = await fs.list("", {
    ...WALK,
    glob: `**/*${literal}*`,
    maxEntries: FALLBACK_MAX_ENTRIES,
  });
  return listed
    .filter((entry) => keepEntry(entry.path, entry.kind))
    .map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind }));
}
