import { create } from 'zustand'
import { resolveSegments } from '../workspace/fs'

/**
 * What the File panel is showing. A workspace path is relative to the chosen
 * folder; a URL is an explicit http(s) link. The panel resolves the rest
 * (loading, viewer choice) from the target's extension.
 */
export type FileTarget =
  | { kind: 'workspace'; path: string }
  | { kind: 'url'; url: string }

export interface FileViewState {
  target: FileTarget | null
  /** Bumped whenever the viewer should reload, including a model re-open of the active path. */
  revision: number
  /** Paths the model has presented this session; drives the strict HTML sandbox. */
  authored: ReadonlySet<string>
  /** User-initiated open. A no-op when the same workspace path is already active. */
  openWorkspace(path: string): void
  openUrl(url: string): void
  /** Model-initiated open. Marks authorship and always reloads, even for the active path. */
  presentWorkspace(path: string): void
  clear(): void
}

/**
 * A description of what the viewer is showing, stable across a no-op reopen so a
 * user re-click never remounts an editor, but changing on a model re-open so the
 * viewer reloads. URL targets do not track the revision.
 */
export function targetKey(target: FileTarget | null, revision: number): string {
  if (!target) return 'none'
  return target.kind === 'workspace' ? `workspace:${target.path}:${revision}` : `url:${target.url}`
}

/**
 * Canonicalizes a workspace path so the tree's `a/b.html` and a model's
 * `./a/b.html` are the same key in the `authored` set. Without this, a model
 * could present an alias and a later user reopen would silently fall back to the
 * same-origin preview sandbox. An unparseable path is left as given so the
 * viewer surfaces its own error.
 */
function canonicalPath(path: string): string {
  try {
    const segments = resolveSegments(path)
    return segments.length > 0 ? segments.join('/') : path
  } catch {
    return path
  }
}

/**
 * One shared target so three entry points agree on what the File panel shows:
 * the Workspace tree (`openWorkspace`), the panel's URL bar (`openUrl`), and
 * clickable http(s) links in chat markdown (`openUrl`). The shell watches
 * `target` to reveal the panel. A fourth entry point, the model's
 * `open_preview` tool, uses `presentWorkspace` so the content can be sandboxed
 * more strictly and a reload is always observable.
 */
export const useFileViewStore = create<FileViewState>((set, get) => ({
  target: null,
  revision: 0,
  authored: new Set<string>(),
  openWorkspace: (path) => {
    const canonical = canonicalPath(path)
    const { target, revision } = get()
    if (target?.kind === 'workspace' && target.path === canonical) return
    set({ target: { kind: 'workspace', path: canonical }, revision: revision + 1 })
  },
  openUrl: (url) => set((state) => ({ target: { kind: 'url', url }, revision: state.revision + 1 })),
  presentWorkspace: (path) =>
    set((state) => {
      const canonical = canonicalPath(path)
      return {
        target: { kind: 'workspace', path: canonical },
        revision: state.revision + 1,
        authored: state.authored.has(canonical)
          ? state.authored
          : new Set(state.authored).add(canonical),
      }
    }),
  clear: () => set({ target: null }),
}))
