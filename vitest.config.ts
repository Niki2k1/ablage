import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Virtual module the module injects at build time; unit tests use a local-processing stub.
      '#ablage-image': fileURLToPath(new URL('./test/utils/virtual-image.ts', import.meta.url)),
      // `nuxt/server` reads build-time virtuals; unit tests use a stub.
      'nuxt/server': fileURLToPath(new URL('./test/utils/virtual-nuxt-server.ts', import.meta.url)),
    },
  },
})
