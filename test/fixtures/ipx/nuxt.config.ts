import MyModule from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    MyModule,
  ],
  ablage: {
    storageName: 'documents',
    storagePath: '.data/test-ipx',
    provider: 'unstorage',
    // Register the local IPX route without @nuxt/image in the fixture.
    image: { enabled: 'force' },
  },
})
