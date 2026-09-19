import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // assistant-ui registry output, copied into the project by the CLI. The
    // upstream source is not written for this repo's strict React rules:
    // it reads refs during render for render-prop caching, exports variants
    // beside components, and uses intentional empty catch blocks.
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'off',
      'react-refresh/only-export-components': 'off',
      'no-empty': 'off',
    },
  },
])
