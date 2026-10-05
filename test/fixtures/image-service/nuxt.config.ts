import MyModule from '../../../src/module'

// Service URL, signing secrets and source origin come from NUXT_FILER_IMAGE_*
// env vars set by the test, like they would in a deployment.
export default defineNuxtConfig({
  modules: [
    MyModule,
  ],
  filer: {
    storageName: 'documents',
    storagePath: '.data/test-image-service',
    provider: 'unstorage',
    image: { enabled: 'force', service: process.env.FILER_TEST_IMAGE_SERVICE === 'ipx' ? 'ipx' : 'imgproxy' },
  },
})
