export default defineNuxtConfig({
  modules: ['../src/module', '@nuxt/image'],
  ablage: {
    storageName: 'documents',
    storagePath: '.data/documents',
    // Set NUXT_S3_* to try S3 and direct uploads (see server/plugins/s3.ts).
    provider: process.env.NUXT_S3_BUCKET ? 'custom' : 'unstorage',
    tus: {
      enabled: true,
      stagingDir: '.data/tus',
      expiration: 1000 * 60 * 60 * 24,
    },
  },
  runtimeConfig: {
    s3: {
      accessKeyId: '',
      secretAccessKey: '',
      endpoint: '',
      publicEndpoint: '',
      region: '',
      bucket: '',
    },
  },
  devtools: { enabled: true },
});
