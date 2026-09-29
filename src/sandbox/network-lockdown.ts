export const BLOCKED_WORKER_GLOBALS = [
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'Worker',
  'SharedWorker',
] as const

export function lockDownNetwork(scope: object = globalThis): void {
  const globals = scope as Record<string, unknown>
  for (const name of BLOCKED_WORKER_GLOBALS) delete globals[name]
}
