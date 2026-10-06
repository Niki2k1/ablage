import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'

await rm(fileURLToPath(new URL('../.data/test-ipx', import.meta.url)), { recursive: true, force: true })

describe('local IPX image route', async () => {
  await setup({ rootDir: fileURLToPath(new URL('./fixtures/ipx', import.meta.url)) })

  const png = await sharp({
    create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer()

  const upload = (groupId: string) =>
    $fetch<{ id: string }>('/api/upload', { method: 'POST', body: { groupId, content: png.toString('base64') } })

  it('resizes and converts a stored image', async () => {
    const { id } = await upload('gallery')
    const res = await fetch(`/_ablage/image/w_50,f_webp/gallery/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 50, height: 25 })
  })

  it('serves the original with `_` modifiers', async () => {
    const { id } = await upload('gallery')
    const res = await fetch(`/_ablage/image/_/gallery/${id}`)
    expect(res.status).toBe(200)
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect(meta).toMatchObject({ format: 'png', width: 200, height: 100 })
  })

  it('handles group ids containing ":" and "/"', async () => {
    const { id } = await upload('organization:5/logos')
    const res = await fetch(`/_ablage/image/s_20x20/organization:5/logos/${id}`)
    expect(res.status).toBe(200)
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect(meta).toMatchObject({ width: 20, height: 20 })
  })

  it('answers 404 for unknown files', async () => {
    const res = await fetch('/_ablage/image/w_50/gallery/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('revalidates with if-modified-since', async () => {
    const { id } = await upload('gallery')
    const first = await fetch(`/_ablage/image/w_50/gallery/${id}`)
    const lastModified = first.headers.get('last-modified')
    expect(lastModified).toBeTruthy()
    const second = await fetch(`/_ablage/image/w_50/gallery/${id}`, { headers: { 'if-modified-since': lastModified! } })
    expect(second.status).toBe(304)
  })
})
