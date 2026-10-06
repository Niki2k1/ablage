import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'
import { makePdf } from './utils/pdf'

const fixtureRoot = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

/** A FileObject as it comes back over JSON (dates as strings). */
interface FileJSON {
  group: string
  id: string
  size: number
  contentType: string
  etag: string
  uploadedAt: string
  updatedAt: string
  name?: string
  width?: number
  height?: number
  customMetadata: Record<string, unknown>
}

interface ListJSON {
  objects: FileJSON[]
  cursor?: string
  hasMore: boolean
}

const put = (body: Record<string, unknown>) => $fetch<FileJSON>('/api/files/put', { method: 'POST', body })
const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

// Wipe persisted storage so tests start from a clean slate.
await rm(fileURLToPath(new URL('../.data/test-documents', import.meta.url)), { recursive: true, force: true })

describe('ablage', async () => {
  await setup({
    rootDir: fixtureRoot,
  })

  it('renders the index page', async () => {
    const html = await $fetch('/')
    expect(html).toContain('basic')
  })

  it('puts a file and reads it back with system and custom metadata', async () => {
    const file = await put({ group: 'docs', content: 'hello', contentType: 'text/plain', name: 'hello.txt', customMetadata: { owner: 'u1' } })
    expect(file).toMatchObject({ group: 'docs', size: 5, contentType: 'text/plain', name: 'hello.txt', customMetadata: { owner: 'u1' } })

    expect(await $fetch<FileJSON>(`/api/files/head?${query({ group: 'docs', id: file.id })}`)).toEqual(file)
    const read = await $fetch<FileJSON & { text: string }>(`/api/files/text?${query({ group: 'docs', id: file.id })}`)
    expect(read.text).toBe('hello')
  })

  it('refuses to overwrite an explicit id unless asked', async () => {
    await put({ group: 'avatars', content: 'one', id: 'user-1' })
    const conflict = await fetch('/api/files/put', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: 'avatars', content: 'two', id: 'user-1' }),
    })
    expect(conflict.status).toBe(409)
    expect(await put({ group: 'avatars', content: 'two', id: 'user-1', overwrite: true })).toMatchObject({ size: 3 })
  })

  it('lists a group page by page', async () => {
    for (const id of ['a', 'b', 'c']) await put({ group: 'paged', content: id, id })
    const first = await $fetch<ListJSON>(`/api/files/list?${query({ group: 'paged', limit: '2' })}`)
    expect(first.objects.map(f => f.id)).toEqual(['a', 'b'])
    expect(first.hasMore).toBe(true)
    const second = await $fetch<ListJSON>(`/api/files/list?${query({ group: 'paged', limit: '2', cursor: first.cursor! })}`)
    expect(second).toMatchObject({ hasMore: false })
    expect(second.objects.map(f => f.id)).toEqual(['c'])
  })

  it('updates metadata and removes files', async () => {
    const file = await put({ group: 'meta', content: 'x', customMetadata: { a: 1 } })
    const updated = await $fetch<FileJSON>('/api/files/update-meta', {
      method: 'POST',
      body: { group: 'meta', id: file.id, patch: { name: 'renamed.txt', customMetadata: { b: 2 } } },
    })
    expect(updated).toMatchObject({ name: 'renamed.txt', etag: file.etag, customMetadata: { a: 1, b: 2 } })

    await $fetch('/api/files/remove', { method: 'POST', body: { refs: [{ group: 'meta', id: file.id }] } })
    expect((await fetch(`/api/files/head?${query({ group: 'meta', id: file.id })}`)).status).toBe(404)
  })

  describe('sendStoredFile', () => {
    it('streams the file with metadata headers, ranges and revalidation', async () => {
      const file = await put({ group: 'served', content: '0123456789', contentType: 'text/plain', name: 'digits.txt' })
      const url = `/api/files/download?${query({ group: 'served', id: file.id })}`

      const full = await fetch(url)
      expect(full.status).toBe(200)
      expect(await full.text()).toBe('0123456789')
      expect(full.headers.get('content-type')).toBe('text/plain')
      expect(full.headers.get('content-length')).toBe('10')
      expect(full.headers.get('etag')).toBe(`"${file.etag}"`)

      const ranged = await fetch(url, { headers: { range: 'bytes=3-5' } })
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-range')).toBe('bytes 3-5/10')
      expect(await ranged.text()).toBe('345')

      expect((await fetch(url, { headers: { 'if-none-match': `"${file.etag}"` } })).status).toBe(304)

      const head = await fetch(url, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe('10')
    })

    it('forces a download with attachment disposition', async () => {
      const file = await put({ group: 'served', content: 'x', name: 'report.pdf', contentType: 'application/pdf' })
      const res = await fetch(`/api/files/download?${query({ group: 'served', id: file.id, disposition: 'attachment' })}`)
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="report\.pdf"/)
    })

    it('answers 404 for missing files', async () => {
      expect((await fetch(`/api/files/download?${query({ group: 'served', id: 'missing' })}`)).status).toBe(404)
    })
  })

  describe('signedUrl', () => {
    it('serves a file only through a valid, unexpired link', async () => {
      const file = await put({ group: 'private', content: 'secret', contentType: 'text/plain', name: 'secret.txt' })
      const link = await $fetch<string>(`/api/files/signed-url?${query({ group: 'private', id: file.id, expiresIn: '60' })}`)
      expect(link).toMatch(new RegExp(`^/_ablage/file/private/${file.id}\\?expires=\\d+&sig=`))

      const ok = await fetch(link)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('secret')
      expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=(5\d|60)$/)
      expect(ok.headers.get('content-disposition')).toMatch(/^inline/)

      const tampered = link.replace(file.id, 'other-id')
      expect((await fetch(tampered)).status).toBe(403)
      expect((await fetch(link.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403)
      expect((await fetch(`/_ablage/file/private/${file.id}`)).status).toBe(403)

      const ranged = await fetch(link, { headers: { range: 'bytes=0-2' } })
      expect(ranged.status).toBe(206)
      expect(await ranged.text()).toBe('sec')
    })

    it('rejects expired links and serves download links as attachments', async () => {
      const file = await put({ group: 'private', content: 'x', name: 'report.pdf' })
      const expired = await $fetch<string>(`/api/files/signed-url?${query({ group: 'private', id: file.id, expiresIn: '1' })}`)
      const download = await $fetch<string>(`/api/files/signed-url?${query({ group: 'private', id: file.id, download: '1' })}`)
      expect((await fetch(download)).headers.get('content-disposition')).toMatch(/^attachment; filename="report\.pdf"/)
      await new Promise(r => setTimeout(r, 2100))
      expect((await fetch(expired)).status).toBe(403)
    })
  })

  it('validates uploads with readUploadedFile', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(16)], 'model.stl', { type: '' }))
    form.append('group', 'models')
    const ok = await $fetch<FileJSON>('/api/files/upload-validated', { method: 'POST', body: form })
    expect(ok).toMatchObject({ group: 'models', name: 'model.stl', contentType: 'application/octet-stream', size: 16 })

    const rejected = new FormData()
    rejected.append('file', new File([new Uint8Array(16)], 'Übersicht.pdf', { type: 'application/pdf' }))
    const res = await fetch('/api/files/upload-validated', { method: 'POST', body: rejected })
    expect(res.status).toBe(415)
    expect((await res.json()).message).toBe('File type of "Übersicht.pdf" is not allowed (allowed: image, .stl)')
  })

  it('generates a PDF preview inside the built server', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(makePdf(200, 100))], 'doc.pdf', { type: 'application/pdf' }))
    const thumb = await $fetch<{ mime: string, width: number, height: number }>('/api/files/thumbnail', { method: 'POST', body: form })
    expect(thumb).toEqual({ mime: 'image/webp', width: 120, height: 60 })
  })

  it('processes an image at upload time via the transform option', async () => {
    const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } } }).png().toBuffer()
    const file = await put({
      group: 'images',
      content: png.toString('base64'),
      base64: true,
      contentType: 'image/png',
      name: 'icon.png',
      transform: { width: 64, format: 'webp' },
    })
    expect(file).toMatchObject({ contentType: 'image/webp', width: 64, height: 64 })
  })

  // Regression: unstorage's fs-lite driver sometimes failed first writes to a
  // new key path with ENOENT; ours uses the kernel's recursive mkdir. Groups
  // with `:` map to nested directories.
  it('first-time upload to a brand-new nested group succeeds', async () => {
    const group = `project:first-${Date.now()}`
    await put({ group, content: 'first', name: 'a.txt' })
    const list = await $fetch<ListJSON>(`/api/files/list?${query({ group })}`)
    expect(list.objects.map(f => f.name)).toEqual(['a.txt'])
  })
})
