import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@chiorim/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
  },
  test: { testTimeout: 15_000 },
})
