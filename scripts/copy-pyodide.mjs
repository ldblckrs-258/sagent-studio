import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

const require = createRequire(import.meta.url)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = dirname(require.resolve('pyodide/pyodide.mjs'))
const targetDir = join(projectRoot, 'public', 'pyodide')

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })
for (const file of FILES) {
  await cp(join(sourceDir, file), join(targetDir, file))
}

console.log(`[copy-pyodide] copied ${FILES.length} files to public/pyodide/`)
