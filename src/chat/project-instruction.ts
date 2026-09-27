import type { WorkspaceApi } from "../tools/types";
import type { ProjectInstruction } from "./context";

export const PROJECT_INSTRUCTION_CANDIDATES = ["AGENTS.md", "README.md"];
export const MAX_PROJECT_INSTRUCTION_CHARS = 8000;

/**
 * Loads the workspace's own instruction file so a fresh session is primed with
 * project conventions instead of inventing them. Returns null when the
 * workspace has none, which the prompt renders as an explicit "none found".
 */
export async function loadProjectInstruction(
  workspace: WorkspaceApi | undefined,
): Promise<ProjectInstruction | null> {
  if (!workspace) return null;
  for (const path of PROJECT_INSTRUCTION_CANDIDATES) {
    try {
      const text = await workspace.readFile(path);
      if (text.trim().length === 0) continue;
      return {
        path,
        text:
          text.length > MAX_PROJECT_INSTRUCTION_CHARS
            ? text.slice(0, MAX_PROJECT_INSTRUCTION_CHARS)
            : text,
      };
    } catch {
      continue;
    }
  }
  return null;
}
