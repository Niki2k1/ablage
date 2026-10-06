import MyModule from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    MyModule,
  ],
  ablage: {
    storageName: 'documents',
    storagePath: '.data/test-tus-documents',
    provider: 'unstorage',
    tus: {
      enabled: true,
      stagingDir: '.data/test-tus-staging',
      maxSize: 1024 * 1024,
    },
  },
})
