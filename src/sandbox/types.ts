export type RunOptions = {
  timeoutMs?: number
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
