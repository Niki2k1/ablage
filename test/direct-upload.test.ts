import { describe, it, expect, vi } from 'vitest'
import { createS3Provider, migrateS3Metadata, type S3Client, type S3ObjectStat } from '../src/runtime/server/providers/s3'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { useFileStorage } from '../src/runtime/server/utils/storage'
import { choosePartSize } from '../src/runtime/server/utils/direct-upload'
import { rangeStream } from '../src/runtime/server/utils/objects'
import type { DirectUpload } from '../src/runtime/types'

vi.mock('nitropack/runtime', () => ({ useRuntimeConfig: () => ({}) }))

const MiB = 1024 * 1024

/**
 * In-memory S3Client with presigned uploads. Its URLs are `mem://` links;
 * `send()` plays the browser, enforcing the declared content-length like a
 * signed header would.
 */
function memoryS3() {
  const store = new Map<string, { data: Uint8Array, metadata: Record<string, string> }>()
  const multipart = new Map<string, { key: string, metadata: Record<string, string>, parts: Map<number, Uint8Array> }>()
  const targets = new Map<string, { key: string, length: number, uploadId?: string, partNumber?: number, metadata?: Record<string, string> }>()
  const aborted: string[] = []
  let nextId = 0

  const client: S3Client = {
    async put(key, body) {
      store.set(key, { data: new Uint8Array(body), metadata: {} })
    },
    async get(key, range) {
      const entry = store.get(key)
      return entry ? rangeStream(entry.data, range) : null
    },
    async head(key) {
      return store.has(key)
    },
    async delete(key) {
      store.delete(key)
    },
    async* listKeys(prefix) {
      for (const key of [...store.keys()].sort()) if (key.startsWith(prefix)) yield key
    },
    async stat(key): Promise<S3ObjectStat | null> {
      const entry = store.get(key)
      return entry ? { size: entry.data.length, etag: `etag-${entry.data.length}`, metadata: entry.metadata } : null
    },
    uploads: {
      async presignPut(key, { contentLength, contentType, metadata }) {
        const url = `mem://${nextId++}`
        targets.set(url, { key, length: contentLength, metadata })
        return { url, headers: { 'content-type': contentType } }
      },
      async createMultipartUpload(key, { metadata }) {
        const uploadId = `up-${nextId++}`
        multipart.set(uploadId, { key, metadata: metadata ?? {}, parts: new Map() })
        return uploadId
      },
      async presignUploadPart(key, { uploadId, partNumber, contentLength }) {
        const url = `mem://${nextId++}`
        targets.set(url, { key, length: contentLength, uploadId, partNumber })
        return url
      },
      async completeMultipartUpload(key, uploadId, parts) {
        const upload = multipart.get(uploadId)!
        const chunks = parts.map(part => upload.parts.get(part.number)!)
        const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.length
        }
        store.set(key, { data, metadata: upload.metadata })
        multipart.delete(uploadId)
      },
      async abortMultipartUpload(_key, uploadId) {
        aborted.push(uploadId)
        multipart.delete(uploadId)
      },
    },
  }

  /** Send bytes to a presigned URL; returns the part's ETag. */
  const send = (url: string, data: Uint8Array): string => {
    const target = targets.get(url)!
    if (data.length !== target.length) throw new Error('403 SignatureDoesNotMatch')
    if (target.uploadId) multipart.get(target.uploadId)!.parts.set(target.partNumber!, data)
    else store.set(target.key, { data, metadata: target.metadata ?? {} })
    return `"part-${target.partNumber}"`
  }

  /** Upload a whole file to what createUpload() returned, like the composable does. */
  const sendAll = (upload: DirectUpload, data: Uint8Array): { number: number, etag: string }[] | undefined => {
    if (upload.type === 'single') {
      send(upload.url, data)
      return undefined
    }
    return upload.parts.map(part => ({
      number: part.number,
      etag: send(part.url, data.subarray((part.number - 1) * upload.partSize, (part.number - 1) * upload.partSize + part.size)),
    }))
  }

  return { client, store, multipart, aborted, send, sendAll }
}

const setup = () => {
  const s3 = memoryS3()
  setFileStorageProvider(createS3Provider({ client: s3.client }))
  return { ...s3, storage: useFileStorage() }
}

describe('direct uploads', () => {
  it('uploads a small file with one presigned PUT and lists it only once completed', async () => {
    const { storage, sendAll } = setup()
    const upload = await storage.createUpload('videos', { size: 3, contentType: 'video/mp4', name: 'a.mp4', customMetadata: { owner: 'u1' } })
    expect(upload).toMatchObject({ type: 'single', method: 'PUT', group: 'videos', headers: { 'content-type': 'video/mp4' } })

    sendAll(upload, new Uint8Array(3))
    expect((await storage.list('videos')).objects).toEqual([])

    const file = await storage.completeUpload(upload.token, { customMetadata: { checked: true } })
    expect(file).toMatchObject({
      group: 'videos',
      id: upload.id,
      size: 3,
      etag: 'etag-3',
      contentType: 'video/mp4',
      name: 'a.mp4',
      customMetadata: { owner: 'u1', checked: true },
    })
    expect(await storage.head(upload)).toEqual(file)
  })

  it('splits large files into presigned parts and completes them in order', async () => {
    const { storage, sendAll, store } = setup()
    const data = new Uint8Array(11 * MiB)
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 251
    const upload = await storage.createUpload('videos', { size: data.length, partSize: 5 * MiB })
    if (upload.type !== 'multipart') throw new Error('expected a multipart upload')
    expect(upload.parts.map(part => part.size)).toEqual([5 * MiB, 5 * MiB, MiB])

    const parts = sendAll(upload, data)!
    await expect(storage.completeUpload(upload.token, { parts: parts.slice(1) })).rejects.toMatchObject({ statusCode: 400 })
    const file = await storage.completeUpload(upload.token, { parts: parts.reverse() })
    expect(file.size).toBe(data.length)
    expect(Buffer.from(store.get(`videos/data/${upload.id}`)!.data).equals(data)).toBe(true)
  })

  it('validates before signing', async () => {
    const { storage } = setup()
    await expect(storage.createUpload('g', { size: 2 * MiB, maxSize: '1MB' })).rejects.toMatchObject({ statusCode: 413 })
    await expect(storage.createUpload('g', { size: 1, contentType: 'text/html', types: ['image', '.pdf'] })).rejects.toMatchObject({ statusCode: 415 })
    await expect(storage.createUpload('g', { size: -1 })).rejects.toMatchObject({ statusCode: 400 })
    await storage.put('g', new Uint8Array(1), { id: 'taken' })
    await expect(storage.createUpload('g', { size: 1, id: 'taken' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects tampered tokens, replays and missing or mismatched bytes', async () => {
    const { storage, sendAll, store } = setup()
    const upload = await storage.createUpload('g', { size: 2 })
    const [body, sig] = upload.token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), size: 9 })).toString('base64url')}.${sig}`
    await expect(storage.completeUpload(forged)).rejects.toMatchObject({ statusCode: 403 })
    await expect(storage.completeUpload(upload.token)).rejects.toMatchObject({ statusCode: 400 })

    // A store that ignored the signed length: the size check catches it and drops the bytes.
    store.set(`g/data/${upload.id}`, { data: new Uint8Array(5), metadata: {} })
    await expect(storage.completeUpload(upload.token)).rejects.toMatchObject({ statusCode: 400 })
    expect(store.has(`g/data/${upload.id}`)).toBe(false)

    sendAll(upload, new Uint8Array(2))
    await storage.completeUpload(upload.token)
    await expect(storage.completeUpload(upload.token)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('aborts unfinished uploads but leaves completed ones alone', async () => {
    const { storage, sendAll, store, aborted } = setup()
    const multipart = await storage.createUpload('g', { size: 6 * MiB, partSize: 5 * MiB })
    await storage.abortUpload(multipart.token)
    expect(aborted).toEqual([(multipart as Extract<DirectUpload, { type: 'multipart' }>).uploadId])

    const single = await storage.createUpload('g', { size: 1 })
    sendAll(single, new Uint8Array(1))
    await storage.abortUpload(single.token)
    expect(store.has(`g/data/${single.id}`)).toBe(false)

    const done = await storage.createUpload('g', { size: 1 })
    sendAll(done, new Uint8Array(1))
    await storage.completeUpload(done.token)
    await storage.abortUpload(done.token)
    expect(await storage.head(done)).not.toBeNull()
  })

  it('migration leaves unfinished direct uploads alone', async () => {
    const { client, storage, sendAll, store } = setup()
    const upload = await storage.createUpload('g', { size: 1 })
    sendAll(upload, new Uint8Array(1))
    expect(await migrateS3Metadata({ client })).toMatchObject({ migrated: 0, skipped: 1 })
    expect(store.has(`g/meta/${upload.id}`)).toBe(false)
  })

  it('needs a provider that can presign writes', async () => {
    const { client } = memoryS3()
    setFileStorageProvider(createS3Provider({ client: { ...client, uploads: undefined } }))
    await expect(useFileStorage().createUpload('g', { size: 1 })).rejects.toThrow(/does not support direct uploads/)
  })
})

describe('choosePartSize', () => {
  it('keeps parts within S3 limits', () => {
    expect(choosePartSize(100)).toBe(16 * MiB)
    expect(choosePartSize(100, MiB)).toBe(5 * MiB)
    // 10,000 parts at most: 1 TiB needs ≥ ~105 MiB parts.
    expect(choosePartSize(1024 * 1024 * MiB)).toBe(105 * MiB)
  })
})
