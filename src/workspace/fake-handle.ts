type FakeFileNode = { kind: 'file'; content: string }
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

export function createFakeWorkspace(initial: Record<string, string> = {}): FakeWorkspace {
  const root: FakeDirNode = { kind: 'directory', children: new Map() }
  let permission: PermissionState = 'granted'

  function fileHandle(node: FakeFileNode, name: string): FileSystemFileHandle {
    return {
      kind: 'file' as const,
      name,
      getFile: async () => {
        const bytes = new TextEncoder().encode(node.content)
        return {
          size: bytes.byteLength,
          text: async () => node.content,
          arrayBuffer: async () => bytes.buffer,
        } as unknown as File
      },
      createWritable: async () => {
        let buffer = ''
        return {
          write: async (data: string | BufferSource) => {
            buffer +=
              typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBufferView)
          },
          close: async () => {
            node.content = buffer
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
        const created: FakeFileNode = { kind: 'file', content: '' }
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
    current.children.set(fileName, { kind: 'file', content })
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
