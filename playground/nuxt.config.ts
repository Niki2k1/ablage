export default defineNuxtConfig({
  modules: ['../src/module', '@nuxt/image'],
  ablage: {
    storageName: 'documents',
    storagePath: '.data/documents',
    provider: 'unstorage',
    tus: {
      enabled: true,
      stagingDir: '.data/tus',
      expiration: 1000 * 60 * 60 * 24,
    },
  },
  devtools: { enabled: true },
});
