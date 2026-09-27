import { create } from "zustand";

/**
 * Which delegated run the Agents panel is showing. The panel no longer owns
 * this locally: a click on a sub-agent tool call in the transcript has to open
 * the panel *and* select that run, so the selection lives where both entry
 * points can reach it. The shell watches `selectedRunId` to reveal the rail.
 */
export interface AgentPanelState {
  selectedRunId: string | null
  /** Opens a run: selects it and asks the shell to reveal the Agents panel. */
  open(runId: string): void
  clear(): void
}

export const useAgentPanelStore = create<AgentPanelState>((set) => ({
  selectedRunId: null,
  open: (runId) => set({ selectedRunId: runId }),
  clear: () => set({ selectedRunId: null }),
}))
