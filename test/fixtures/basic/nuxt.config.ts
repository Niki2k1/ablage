import MyModule from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    MyModule,
  ],
  runtimeConfig: {
    // For signedUrl(); a test-only value.
    appSecret: 'test-app-secret-test-app-secret-0123456789',
  },
  ablage: {
    storageName: 'documents',
    storagePath: '.data/test-documents',
    provider: 'unstorage',
  },
})
