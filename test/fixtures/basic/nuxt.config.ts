import MyModule from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    MyModule,
  ],
  ablage: {
    storageName: 'documents',
    storagePath: '.data/test-documents',
    provider: 'unstorage',
  },
})
