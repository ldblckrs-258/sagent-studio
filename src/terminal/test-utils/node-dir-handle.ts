import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

function notFound(name: string): DOMException {
  return new DOMException(`"${name}" was not found.`, 'NotFoundError')
}

function typeMismatch(name: string): DOMException {
  return new DOMException(`"${name}" is not the expected kind.`, 'TypeMismatchError')
}

function exists(path: string): 'file' | 'directory' | null {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'file'
  } catch {
    return null
  }
}

async function toBuffer(data: unknown): Promise<Buffer> {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer())
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw new TypeError('Unsupported write payload')
}

class NodeFileHandle {
  readonly kind = 'file'
  readonly name: string
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.name = basename(path)
  }

  async getFile(): Promise<File> {
    return new File([readFileSync(this.path)], this.name)
  }

  async createWritable() {
    const chunks: Buffer[] = []
    const path = this.path
    return {
      async write(data: unknown) {
        chunks.push(await toBuffer(data))
      },
      async close() {
        writeFileSync(path, Buffer.concat(chunks))
      },
      async abort() {
        chunks.length = 0
      },
    }
  }

  async isSameEntry(other: { path?: string }): Promise<boolean> {
    return other.path === this.path
  }
}

export class NodeDirHandle {
  readonly kind = 'directory'
  readonly name: string
  readonly path: string
  permission: PermissionState = 'granted'

  constructor(path: string) {
    this.path = realpathSync(path)
    this.name = basename(this.path)
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<NodeDirHandle> {
    const path = join(this.path, name)
    const kind = exists(path)
    if (kind === 'file') throw typeMismatch(name)
    if (kind === null) {
      if (!options.create) throw notFound(name)
      mkdirSync(path)
    }
    const child = new NodeDirHandle(path)
    child.permission = this.permission
    return child
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<NodeFileHandle> {
    const path = join(this.path, name)
    const kind = exists(path)
    if (kind === 'directory') throw typeMismatch(name)
    if (kind === null) {
      if (!options.create) throw notFound(name)
      writeFileSync(path, '')
    }
    return new NodeFileHandle(path)
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const path = join(this.path, name)
    if (exists(path) === null) throw notFound(name)
    rmSync(path, { recursive: options.recursive ?? false })
  }

  async isSameEntry(other: { path?: string }): Promise<boolean> {
    return other.path === this.path
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission
  }

  async requestPermission(): Promise<PermissionState> {
    return this.permission
  }
}

export function nodeDirHandle(path: string): FileSystemDirectoryHandle & NodeDirHandle {
  return new NodeDirHandle(path) as unknown as FileSystemDirectoryHandle & NodeDirHandle
}
