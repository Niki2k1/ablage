import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'

const fixtureRoot = fileURLToPath(new URL('./fixtures/tus', import.meta.url))

// Wipe persisted storage so tests start from a clean slate.
await rm(fileURLToPath(new URL('../.data/test-tus-documents', import.meta.url)), { recursive: true, force: true })
await rm(fileURLToPath(new URL('../.data/test-tus-staging', import.meta.url)), { recursive: true, force: true })

const TUS = { 'Tus-Resumable': '1.0.0' }

interface InfoResult {
  exists: boolean
  id?: string
  offset?: number
  size?: number
  metadata?: Record<string, string | null>
}

interface PromoteResult {
  group: string
  id: string
  name?: string
  contentType: string
  size: number
  customMetadata: Record<string, unknown>
}

interface FileResult extends PromoteResult {
  text: string
}

function encodeMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',')
}

async function createUpload(content: string, metadata: Record<string, string>) {
  const res = await fetch('/_ablage/tus', {
    method: 'POST',
    headers: {
      ...TUS,
      'Upload-Length': String(Buffer.byteLength(content)),
      'Upload-Metadata': encodeMetadata(metadata),
    },
  })
  expect(res.status).toBe(201)
  const location = res.headers.get('location')!
  expect(location).toBeTruthy()
  // Location may be absolute; extract the pathname for follow-up requests.
  const uploadPath = new URL(location, 'http://localhost').pathname
  const tusId = uploadPath.split('/').pop()!
  return { uploadPath, tusId }
}

async function patchUpload(uploadPath: string, content: string, offset: number) {
  return await fetch(uploadPath, {
    method: 'PATCH',
    headers: {
      ...TUS,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: content,
  })
}

async function headUpload(uploadPath: string) {
  return await fetch(uploadPath, { method: 'HEAD', headers: { ...TUS } })
}

describe('ablage tus', async () => {
  await setup({
    rootDir: fixtureRoot,
  })

  it('answers OPTIONS with tus capabilities', async () => {
    const res = await fetch('/_ablage/tus', { method: 'OPTIONS' })
    expect([200, 204]).toContain(res.status)
    expect(res.headers.get('tus-version')).toBeTruthy()
    expect(res.headers.get('tus-extension')).toContain('creation')
  })

  it('creates, uploads, and HEAD-checks a file in one PATCH', async () => {
    const content = 'hello tus world'
    const { uploadPath } = await createUpload(content, {
      filename: 'hello.txt',
      filetype: 'text/plain',
    })

    const before = await headUpload(uploadPath)
    expect(before.status).toBe(200)
    expect(before.headers.get('upload-offset')).toBe('0')

    const patch = await patchUpload(uploadPath, content, 0)
    expect(patch.status).toBe(204)
    expect(patch.headers.get('upload-offset')).toBe(String(Buffer.byteLength(content)))

    const after = await headUpload(uploadPath)
    expect(after.headers.get('upload-offset')).toBe(String(Buffer.byteLength(content)))
    expect(after.headers.get('upload-length')).toBe(String(Buffer.byteLength(content)))
  })

  it('resumes an interrupted upload across two PATCH requests', async () => {
    const part1 = 'first half|'
    const part2 = 'second half'
    const content = part1 + part2
    const { uploadPath, tusId } = await createUpload(content, {
      filename: 'chunked.txt',
      filetype: 'text/plain',
    })

    const patch1 = await patchUpload(uploadPath, part1, 0)
    expect(patch1.status).toBe(204)

    // A client would HEAD to learn the offset before resuming.
    const head = await headUpload(uploadPath)
    const offset = Number(head.headers.get('upload-offset'))
    expect(offset).toBe(Buffer.byteLength(part1))

    const patch2 = await patchUpload(uploadPath, part2, offset)
    expect(patch2.status).toBe(204)

    const info = await $fetch<InfoResult>(`/api/tus/info?tusId=${tusId}`)
    expect(info.exists).toBe(true)
    expect(info.offset).toBe(Buffer.byteLength(content))
    expect(info.size).toBe(Buffer.byteLength(content))
    expect(info.metadata?.filename).toBe('chunked.txt')
  })

  it('promotes a staged upload into the file storage', async () => {
    const content = 'promote me'
    const { uploadPath, tusId } = await createUpload(content, {
      filename: 'promoted.txt',
      filetype: 'text/plain',
    })
    await patchUpload(uploadPath, content, 0)

    const result = await $fetch<PromoteResult>('/api/tus/promote', {
      method: 'POST',
      body: { tusId, group: 'promote-group' },
    })
    // name and contentType fall back to the tus metadata
    expect(result).toMatchObject({ group: 'promote-group', name: 'promoted.txt', contentType: 'text/plain', size: content.length })

    const file = await $fetch<FileResult>(`/api/files/get?group=promote-group&id=${result.id}`)
    expect(file.text).toBe(content)
    expect(file.name).toBe('promoted.txt')

    // staged copy is removed by default
    const info = await $fetch<InfoResult>(`/api/tus/info?tusId=${tusId}`)
    expect(info.exists).toBe(false)
  })

  it('promote applies option overrides over tus metadata', async () => {
    const content = 'override meta'
    const { uploadPath, tusId } = await createUpload(content, {
      filename: 'original.bin',
      filetype: 'application/octet-stream',
    })
    await patchUpload(uploadPath, content, 0)

    const result = await $fetch<PromoteResult>('/api/tus/promote', {
      method: 'POST',
      body: {
        tusId,
        group: 'override-group',
        id: 'fixed-id',
        name: 'renamed.bin',
        customMetadata: { kind: 'attachment', comment: 'hi' },
      },
    })
    expect(result).toMatchObject({
      id: 'fixed-id',
      name: 'renamed.bin',
      contentType: 'application/octet-stream',
      customMetadata: { kind: 'attachment', comment: 'hi' },
    })
  })

  it('rejects promoting an incomplete upload with 409', async () => {
    const content = 'not quite done'
    const { uploadPath, tusId } = await createUpload(content, {
      filename: 'partial.txt',
      filetype: 'text/plain',
    })
    await patchUpload(uploadPath, content.slice(0, 4), 0)

    const res = await fetch('/api/tus/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tusId, group: 'partial-group' }),
    })
    expect(res.status).toBe(409)
  })

  it('rejects promoting an unknown id with 404', async () => {
    const res = await fetch('/api/tus/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tusId: 'does-not-exist', group: 'g' }),
    })
    expect(res.status).toBe(404)
  })

  it('terminates an upload via DELETE', async () => {
    const content = 'delete me'
    const { uploadPath, tusId } = await createUpload(content, {
      filename: 'doomed.txt',
      filetype: 'text/plain',
    })
    await patchUpload(uploadPath, content, 0)

    const del = await fetch(uploadPath, { method: 'DELETE', headers: { ...TUS } })
    expect(del.status).toBe(204)

    const info = await $fetch<InfoResult>(`/api/tus/info?tusId=${tusId}`)
    expect(info.exists).toBe(false)
  })

  it('bulk-deletes staged uploads via the cleanup beacon route', async () => {
    const a = await createUpload('beacon a', { filename: 'a.txt', filetype: 'text/plain' })
    const b = await createUpload('beacon b', { filename: 'b.txt', filetype: 'text/plain' })
    await patchUpload(a.uploadPath, 'beacon a', 0)

    const res = await fetch('/_ablage/tus/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tusIds: [a.tusId, b.tusId, '../evil', 42] }),
    })
    expect(res.status).toBe(204)

    expect((await $fetch<InfoResult>(`/api/tus/info?tusId=${a.tusId}`)).exists).toBe(false)
    expect((await $fetch<InfoResult>(`/api/tus/info?tusId=${b.tusId}`)).exists).toBe(false)
  })

  it('enforces maxSize at creation time', async () => {
    const res = await fetch('/_ablage/tus', {
      method: 'POST',
      headers: {
        ...TUS,
        'Upload-Length': String(2 * 1024 * 1024),
        'Upload-Metadata': encodeMetadata({ filename: 'big.bin' }),
      },
    })
    expect(res.status).toBe(413)
  })
})
