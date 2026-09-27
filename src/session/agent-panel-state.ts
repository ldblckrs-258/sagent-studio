import { create } from "zustand";

/**
 * Which delegated run is open in the full-width run view. Every entry point
 * (an Agents list row, a sub-agent tool call, a sub-agent report) selects
 * through this store, and the shell swaps the main thread for the run view.
 */
export interface AgentPanelState {
  selectedRunId: string | null
  /** Opens a run in the main area in place of the conversation. */
  open(runId: string): void
  clear(): void
}

export const useAgentPanelStore = create<AgentPanelState>((set) => ({
  selectedRunId: null,
  open: (runId) => set({ selectedRunId: runId }),
  clear: () => set({ selectedRunId: null }),
}))
