import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'

// Runs against a real service, skipped unless one is configured:
// - imgproxy on the host network, then set IMGPROXY_URL / IMGPROXY_KEY / IMGPROXY_SALT:
//     docker run --rm --network host -e IMGPROXY_KEY=<hex> -e IMGPROXY_SALT=<hex> \
//       -e IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES=true ghcr.io/imgproxy/imgproxy
// - or a standalone IPX, then set IPX_URL:
//     npx ipx serve --domains 127.0.0.1 --port 8090
const service = process.env.IPX_URL ? 'ipx' : 'imgproxy'
const imgproxyURL = process.env.IPX_URL ?? process.env.IMGPROXY_URL
const port = 3999

describe.skipIf(!imgproxyURL)(`image service: ${service}`, async () => {
  process.env.FILER_TEST_IMAGE_SERVICE = service
  await rm(fileURLToPath(new URL('../.data/test-image-service', import.meta.url)), { recursive: true, force: true })
  process.env.NUXT_ABLAGE_IMAGE_BASE_URL = imgproxyURL
  process.env.NUXT_ABLAGE_IMAGE_KEY = process.env.IMGPROXY_KEY ?? ''
  process.env.NUXT_ABLAGE_IMAGE_SALT = process.env.IMGPROXY_SALT ?? ''
  process.env.NUXT_ABLAGE_IMAGE_SOURCE_URL = `http://127.0.0.1:${port}`

  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/image-service', import.meta.url)),
    port,
  })

  const png = await sharp({
    create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } },
  }).png().toBuffer()

  it('transforms at upload time through the service and cleans up the staged original', async () => {
    const result = await $fetch<{ file: { contentType: string, width: number, height: number }, staged: unknown[] }>('/api/upload', {
      method: 'POST',
      body: {
        group: 'organization:5',
        content: png.toString('base64'),
        contentType: 'image/png',
        name: 'logo.png',
        transform: { width: 64, format: 'webp' },
      },
    })
    expect(result.file).toMatchObject({ contentType: 'image/webp', width: 64, height: 32 })
    expect(result.staged).toEqual([])
  })

  it('serves originals on `_` and redirects variants to a working service URL', async () => {
    const { file: { id } } = await $fetch<{ file: { id: string } }>('/api/upload', {
      method: 'POST',
      body: { group: 'organization:5', content: png.toString('base64'), contentType: 'image/png', name: 'logo.png' },
    })

    const original = await fetch(`/_ablage/image/_/organization:5/${id}`)
    expect(original.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await original.arrayBuffer()).equals(png)).toBe(true)

    const redirect = await fetch(`/_ablage/image/s_100x100,f_webp/organization:5/${id}`, { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    const location = redirect.headers.get('location')!
    expect(location.startsWith(`${imgproxyURL}/`)).toBe(true)

    const variant = await globalThis.fetch(location)
    expect(variant.status).toBe(200)
    const meta = await sharp(Buffer.from(await variant.arrayBuffer())).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 100, height: 100 })
  })
})
