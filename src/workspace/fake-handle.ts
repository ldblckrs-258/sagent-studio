type FakeFileNode = { kind: 'file'; content: Uint8Array }
type FakeDirNode = { kind: 'directory'; children: Map<string, FakeNode> }
type FakeNode = FakeFileNode | FakeDirNode

export interface FakeWorkspace {
  handle: FileSystemDirectoryHandle
  setPermission(state: PermissionState): void
  seed(path: string, content: string): void
  makeNode(path: string): void
}

function notFound(name: string): DOMException {
  return new DOMException(`"${name}" was not found.`, 'NotFoundError')
}

async function toBytes(data: string | BufferSource | Blob): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  }
  return new Uint8Array(data.slice(0))
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export function createFakeWorkspace(initial: Record<string, string> = {}): FakeWorkspace {
  const root: FakeDirNode = { kind: 'directory', children: new Map() }
  let permission: PermissionState = 'granted'

  function fileHandle(node: FakeFileNode, name: string): FileSystemFileHandle {
    return {
      kind: 'file' as const,
      name,
      getFile: async () => {
        const bytes = node.content
        return {
          size: bytes.byteLength,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
          slice: (start = 0, end = bytes.byteLength) => {
            const slice = bytes.slice(start, end)
            return {
              size: slice.byteLength,
              arrayBuffer: async () => slice.buffer,
              text: async () => new TextDecoder().decode(slice),
            }
          },
        } as unknown as File
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = []
        return {
          write: async (data: string | BufferSource | Blob) => {
            chunks.push(await toBytes(data))
          },
          close: async () => {
            node.content = concatBytes(chunks)
          },
        } as unknown as FileSystemWritableFileStream
      },
    } as unknown as FileSystemFileHandle
  }

  function dirHandle(node: FakeDirNode, name: string): FileSystemDirectoryHandle {
    return {
      kind: 'directory' as const,
      name,
      getDirectoryHandle: async (childName: string, options?: { create?: boolean }) => {
        const existing = node.children.get(childName)
        if (existing) {
          if (existing.kind !== 'directory') {
            throw new DOMException(`"${childName}" is not a directory.`, 'TypeMismatchError')
          }
          return dirHandle(existing, childName)
        }
        if (!options?.create) throw notFound(childName)
        const created: FakeDirNode = { kind: 'directory', children: new Map() }
        node.children.set(childName, created)
        return dirHandle(created, childName)
      },
      getFileHandle: async (childName: string, options?: { create?: boolean }) => {
        const existing = node.children.get(childName)
        if (existing) {
          if (existing.kind !== 'file') {
            throw new DOMException(`"${childName}" is not a file.`, 'TypeMismatchError')
          }
          return fileHandle(existing, childName)
        }
        if (!options?.create) throw notFound(childName)
        const created: FakeFileNode = { kind: 'file', content: new Uint8Array() }
        node.children.set(childName, created)
        return fileHandle(created, childName)
      },
      removeEntry: async (childName: string, options?: { recursive?: boolean }) => {
        const existing = node.children.get(childName)
        if (!existing) throw notFound(childName)
        if (existing.kind === 'directory' && !options?.recursive && existing.children.size > 0) {
          throw new DOMException(`"${childName}" is not empty.`, 'InvalidModificationError')
        }
        node.children.delete(childName)
      },
      values: async function* () {
        for (const [childName, child] of node.children) {
          yield child.kind === 'directory' ? dirHandle(child, childName) : fileHandle(child, childName)
        }
      },
      queryPermission: async () => permission,
      requestPermission: async () => permission,
    } as unknown as FileSystemDirectoryHandle
  }

  function makeNode(path: string): void {
    const segments = path.split('/').filter((segment) => segment.length > 0)
    let current = root
    for (const segment of segments) {
      const existing = current.children.get(segment)
      if (existing && existing.kind === 'directory') {
        current = existing
        continue
      }
      const created: FakeDirNode = { kind: 'directory', children: new Map() }
      current.children.set(segment, created)
      current = created
    }
  }

  function seed(path: string, content: string): void {
    const segments = path.split('/').filter((segment) => segment.length > 0)
    const fileName = segments.pop()
    if (fileName === undefined) throw new Error('seed requires a file path')
    let current = root
    for (const segment of segments) {
      const existing = current.children.get(segment)
      if (!existing || existing.kind !== 'directory') {
        const created: FakeDirNode = { kind: 'directory', children: new Map() }
        current.children.set(segment, created)
        current = created
      } else {
        current = existing
      }
    }
    current.children.set(fileName, { kind: 'file', content: new TextEncoder().encode(content) })
  }

  for (const [path, content] of Object.entries(initial)) seed(path, content)

  return {
    handle: dirHandle(root, ''),
    setPermission: (state) => {
      permission = state
    },
    seed,
    makeNode,
  }
}
