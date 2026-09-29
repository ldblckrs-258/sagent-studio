import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The chat elements are authored against the `@/` alias, so a test that
  // renders one needs the same resolution the app build uses.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'sagent-bridge/protocol': fileURLToPath(
        new URL('./packages/sagent-bridge/src/protocol.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    globalSetup: ['./src/terminal/test-utils/global-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
