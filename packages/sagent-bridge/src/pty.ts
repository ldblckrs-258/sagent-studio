import type { IPty, IPtyForkOptions } from '@lydell/node-pty'

export type { IPty }

export interface PtyModule {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty
}

export async function loadPty(): Promise<PtyModule | null> {
  try {
    const mod = (await import('@lydell/node-pty')) as unknown as PtyModule & { default?: PtyModule }
    const spawn = mod.spawn ?? mod.default?.spawn
    if (typeof spawn !== 'function') return null
    return { spawn: (file, args, options) => spawn(file, args, options) }
  } catch {
    return null
  }
}
