import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsup'

const require = createRequire(import.meta.url)

export default defineConfig({
  entry: ['src/cli.ts', 'src/protocol.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: false,
  shims: false,
  onSuccess: async () => {
    mkdirSync('dist', { recursive: true })
    copyFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'), 'dist/tree-sitter-bash.wasm')
  },
})
