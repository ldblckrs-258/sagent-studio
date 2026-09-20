import type { WorkspaceJournal } from '../workspace/journal'

export type RunOptions = {
  timeoutMs?: number
  /** The conversation journal to record sandbox writes into, when one applies. */
  journal?: WorkspaceJournal
}

export type RunResult = {
  stdout: string
  stderr: string
  result: string | null
  error?: string
}

export interface CodeRunner {
  run(source: string, options: RunOptions): Promise<RunResult>
}
