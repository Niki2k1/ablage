import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Virtual module the module injects at build time; unit tests use a local-processing stub.
      '#ablage-image': fileURLToPath(new URL('./test/utils/virtual-image.ts', import.meta.url)),
    },
  },
})
