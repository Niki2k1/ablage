import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'
import { makePdf } from './utils/pdf'

const fixtureRoot = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

interface UploadResult {
  id: string
  groupId: string
  meta?: { mime: string, width?: number, height?: number }
}

interface FileEntry {
  id: string
  groupId: string
  meta: { name: string, mime: string, version: number, comment?: string }
  createdAt?: string
  updatedAt?: string
}

interface FileWithData extends FileEntry {
  data?: string
}

interface DuplicateResult {
  exists: boolean
}

// Wipe persisted storage so tests start from a clean slate.
await rm(fileURLToPath(new URL('../.data/test-documents', import.meta.url)), { recursive: true, force: true })

describe('nuxt-filer', async () => {
  await setup({
    rootDir: fixtureRoot,
  })

  it('renders the index page', async () => {
    const html = await $fetch('/')
    expect(html).toContain('<div>basic</div>')
  })

  it('uploads a file and returns an id', async () => {
    const result = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'test-group',
        content: 'hello world',
        meta: { name: 'test.txt', mime: 'text/plain', type: 'document', version: 1 },
      },
    })

    expect(result.id).toBeDefined()
    expect(result.groupId).toBe('test-group')
  })

  it('lists files in a group', async () => {
    const files = await $fetch<FileEntry[]>('/api/files/list?groupId=test-group')

    expect(files.length).toBeGreaterThanOrEqual(1)
    expect(files[0]!.meta.name).toBe('test.txt')
    expect(files[0]!.meta.mime).toBe('text/plain')
    expect(files[0]!.groupId).toBe('test-group')
  })

  it('gets a file with data', async () => {
    const uploaded = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'get-test-group',
        content: 'hello world',
        meta: { name: 'get.txt', mime: 'text/plain', type: 'document', version: 1 },
      },
    })

    const file = await $fetch<FileWithData>(`/api/files/get?groupId=get-test-group&id=${uploaded.id}`)

    expect(file.id).toBe(uploaded.id)
    expect(file.data).toBe('hello world')
    expect(file.meta.name).toBe('get.txt')
  })

  it('serves a stored file via sendStoredFile', async () => {
    const uploaded = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'download-group',
        content: 'raw download body',
        meta: { name: 'résumé.txt', mime: 'text/plain', type: 'document', version: 1 },
      },
    })

    const res = await fetch(`/api/files/download?groupId=download-group&id=${uploaded.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength('raw download body')))
    expect(res.headers.get('etag')).toBeTruthy()
    expect(res.headers.get('last-modified')).toBeTruthy()
    // inline by default; UTF-8 filename carried in filename*.
    const disposition = res.headers.get('content-disposition')!
    expect(disposition).toContain('inline')
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt")
    expect(await res.text()).toBe('raw download body')
  })

  it('opt-in attachment disposition forces a download', async () => {
    const uploaded = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'download-group',
        content: 'attachment body',
        meta: { name: 'report.pdf', mime: 'application/pdf', type: 'report', version: 1 },
      },
    })

    const res = await fetch(`/api/files/download?groupId=download-group&id=${uploaded.id}&disposition=attachment`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })

  it('revalidates with 304 when if-none-match matches the etag', async () => {
    const uploaded = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'download-group',
        content: 'cacheable body',
        meta: { name: 'cache.txt', mime: 'text/plain', type: 'document', version: 1 },
      },
    })

    const first = await fetch(`/api/files/download?groupId=download-group&id=${uploaded.id}`)
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await fetch(`/api/files/download?groupId=download-group&id=${uploaded.id}`, {
      headers: { 'if-none-match': etag },
    })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('returns 404 for a missing file', async () => {
    const res = await fetch('/api/files/download?groupId=download-group&id=does-not-exist')
    expect(res.status).toBe(404)
  })

  it('updates file metadata', async () => {
    const files = await $fetch<FileEntry[]>('/api/files/list?groupId=test-group')
    const fileId = files[0]!.id

    await $fetch('/api/files/update-meta', {
      method: 'POST',
      body: { id: fileId, meta: { comment: 'updated comment' } },
    })

    const file = await $fetch<FileWithData>(`/api/files/get?groupId=test-group&id=${fileId}`)
    expect(file.meta.comment).toBe('updated comment')
    // original fields preserved via defu merge
    expect(file.meta.name).toBe('test.txt')
  })

  it('checks for duplicates', async () => {
    const result = await $fetch<DuplicateResult>('/api/files/check-duplicate?groupId=test-group&key=name&value=test.txt')
    expect(result.exists).toBe(true)

    const noResult = await $fetch<DuplicateResult>('/api/files/check-duplicate?groupId=test-group&key=name&value=nonexistent.txt')
    expect(noResult.exists).toBe(false)
  })

  it('handles versioning - getLatestVersions', async () => {
    // Upload a v2 of the same file name
    await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'test-group',
        content: 'hello world v2',
        meta: { name: 'test.txt', mime: 'text/plain', type: 'document', version: 2 },
      },
    })

    const latest = await $fetch<FileEntry[]>('/api/files/latest-versions?groupId=test-group')

    const testFile = latest.find((f: { meta: { name: string } }) => f.meta.name === 'test.txt')
    expect(testFile).toBeDefined()
    expect(testFile!.meta.version).toBe(2)
  })

  it('uploads to different groups independently', async () => {
    await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: 'other-group',
        content: 'other content',
        meta: { name: 'other.pdf', mime: 'application/pdf', type: 'report', version: 1 },
      },
    })

    const otherFiles = await $fetch<FileEntry[]>('/api/files/list?groupId=other-group')
    expect(otherFiles.length).toBe(1)
    expect(otherFiles[0]!.meta.name).toBe('other.pdf')

    // Original group still has its files
    const testFiles = await $fetch<FileEntry[]>('/api/files/list?groupId=test-group')
    expect(testFiles.length).toBeGreaterThanOrEqual(2)
  })

  it('removes a file', async () => {
    const files = await $fetch<FileEntry[]>('/api/files/list?groupId=other-group')
    const fileId = files[0]!.id

    await $fetch('/api/files/remove', {
      method: 'POST',
      body: { groupId: 'other-group', id: fileId },
    })

    const remaining = await $fetch<FileEntry[]>('/api/files/list?groupId=other-group')
    expect(remaining.length).toBe(0)
  })

  it('returns empty list for unknown group', async () => {
    const files = await $fetch<FileEntry[]>('/api/files/list?groupId=nonexistent')
    expect(files).toEqual([])
  })

  it('validates uploads with readUploadedFile', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(16)], 'model.stl', { type: '' }))
    form.append('group', 'models')
    const ok = await $fetch<{ name: string, type: string, size: number, group: string }>('/api/files/upload-validated', { method: 'POST', body: form })
    expect(ok).toMatchObject({ name: 'model.stl', type: 'application/octet-stream', size: 16, group: 'models' })

    const rejected = new FormData()
    rejected.append('file', new File([new Uint8Array(16)], 'Übersicht.pdf', { type: 'application/pdf' }))
    const res = await fetch('/api/files/upload-validated', { method: 'POST', body: rejected })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.message).toBe('File type of "Übersicht.pdf" is not allowed (allowed: image, .stl)')
  })

  it('generates a PDF preview inside the built server', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(makePdf(200, 100))], 'doc.pdf', { type: 'application/pdf' }))
    const thumb = await $fetch<{ mime: string, width: number, height: number }>('/api/files/thumbnail', { method: 'POST', body: form })
    expect(thumb).toEqual({ mime: 'image/webp', width: 120, height: 60 })
  })

  it('processes an image at upload time via the transform option', async () => {
    const png = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 0, g: 128, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer()

    const result = await $fetch<UploadResult>('/api/files/upload-image', {
      method: 'POST',
      body: {
        groupId: 'image-group',
        content: png.toString('base64'),
        meta: { name: 'icon.png', mime: 'image/png', type: 'image', version: 1 },
        transform: { width: 64, format: 'webp' },
      },
    })

    expect(result.id).toBeDefined()
    // Upload-time processing rewrites the stored mime + dimensions.
    expect(result.meta!.mime).toBe('image/webp')
    expect(result.meta!.width).toBe(64)
    expect(result.meta!.height).toBe(64)
  })

  // Regression: the previous default driver (unstorage's fs-lite) sometimes
  // failed first-time writes to a brand-new key path with ENOENT because its
  // userspace `ensuredir` recursion is not as reliable as the kernel's
  // recursive mkdir. Group IDs with `:` map to nested directories.
  it('first-time upload to a brand-new nested group succeeds', async () => {
    const uniqueGroup = `project:first-${Date.now()}`
    const result = await $fetch<UploadResult>('/api/files/upload', {
      method: 'POST',
      body: {
        groupId: uniqueGroup,
        content: 'first',
        meta: { name: 'a.txt', mime: 'text/plain', type: 'document', version: 1 },
      },
    })
    expect(result.id).toBeDefined()

    const files = await $fetch<FileEntry[]>(`/api/files/list?groupId=${encodeURIComponent(uniqueGroup)}`)
    expect(files.length).toBe(1)
    expect(files[0]!.meta.name).toBe('a.txt')
  })
})
