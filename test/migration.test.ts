import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { useFileStorage } from '../src/runtime/server/utils/storage'
import { createS3Provider, migrateS3Metadata, type S3Client } from '../src/runtime/server/providers/s3'
import { rangeStream } from '../src/runtime/server/utils/objects'
import { createHash } from 'node:crypto'

const storage = await vi.hoisted(async () => (await import('./utils/nitro-mock')).createNitroStorage())
vi.mock('nitropack/runtime', async () => (await import('./utils/nitro-mock')).nitroRuntimeMock(storage))
const { createUnstorageProvider, migrateUnstorageMetadata } = await import('../src/runtime/server/providers/unstorage')

const bytes = (text: string) => new TextEncoder().encode(text)
const sha = (text: string) => createHash('sha256').update(text).digest('base64url')

/** Metadata exactly as nuxt-filer 0.0.x's unstorage and S3 providers wrote it. */
const legacyMeta = {
  name: 'logo.svg',
  mime: 'image/svg+xml',
  type: 'image',
  version: 2,
  alt: 'Logo',
  width: 64,
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
}

const expected = {
  group: 'organization:5',
  id: 'f1',
  size: 4,
  etag: sha('logo'),
  name: 'logo.svg',
  contentType: 'image/svg+xml',
  width: 64,
  uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  customMetadata: { type: 'image', version: 2, alt: 'Logo' },
}

describe('migrateUnstorageMetadata', () => {
  const docs = () => storage
  beforeEach(() => storage.clear('documents'))

  it('converts 0.0.x sidecars, adds missing ones and is idempotent', async () => {
    await docs().setItemRaw('documents:organization:5:data:f1', bytes('logo'))
    await docs().setItem('documents:organization:5:meta:f1', legacyMeta)
    // 0.0.x wrote no sidecar when upload() got no meta.
    await docs().setItemRaw('documents:g:data:bare', bytes('xy'))
    // A sidecar whose bytes are gone.
    await docs().setItem('documents:g:meta:ghost', { name: 'gone' })

    expect(await migrateUnstorageMetadata({ from: 'documents' })).toEqual({ migrated: 2, skipped: 0, orphaned: ['g:meta:ghost'] })
    expect(await migrateUnstorageMetadata({ from: 'documents' })).toEqual({ migrated: 0, skipped: 2, orphaned: ['g:meta:ghost'] })

    setFileStorageProvider(createUnstorageProvider('documents'))
    const files = useFileStorage()
    expect(await files.head({ group: 'organization:5', id: 'f1' })).toEqual(expected)
    expect(new TextDecoder().decode(await (await files.get({ group: 'organization:5', id: 'f1' }))!.bytes())).toBe('logo')
    expect(await files.head({ group: 'g', id: 'bare' })).toMatchObject({ size: 2, contentType: 'application/octet-stream', customMetadata: {} })
    expect((await files.list('g')).objects.map(f => f.id)).toEqual(['bare'])
  })
})

describe('migrateS3Metadata', () => {
  function memoryClient() {
    const store = new Map<string, Uint8Array>()
    const client: S3Client = {
      async put(key, body) { store.set(key, new Uint8Array(body)) },
      async get(key, range) { const d = store.get(key); return d ? rangeStream(d, range) : null },
      async head(key) { return store.has(key) },
      async delete(key) { store.delete(key) },
      async* listKeys(prefix, options) {
        for (const key of [...store.keys()].sort()) {
          if (key.startsWith(prefix) && (!options?.startAfter || key > options.startAfter)) yield key
        }
      },
    }
    return { client, store }
  }

  it('converts 0.0.x metadata objects under a prefix and is idempotent', async () => {
    const { client, store } = memoryClient()
    store.set('media/organization:5/data/f1', bytes('logo'))
    store.set('media/organization:5/meta/f1', bytes(JSON.stringify(legacyMeta)))
    store.set('media/g/data/bare', bytes('xy'))
    store.set('other/g/data/outside', bytes('z'))

    expect(await migrateS3Metadata({ client, prefix: 'media' })).toEqual({ migrated: 2, skipped: 0, orphaned: [] })
    expect(await migrateS3Metadata({ client, prefix: 'media' })).toEqual({ migrated: 0, skipped: 2, orphaned: [] })
    expect(store.has('other/g/meta/outside')).toBe(false)

    setFileStorageProvider(createS3Provider({ client, prefix: 'media' }))
    expect(await useFileStorage().head({ group: 'organization:5', id: 'f1' })).toEqual(expected)
    expect(await useFileStorage().head({ group: 'g', id: 'bare' })).toMatchObject({ size: 2 })
  })
})
