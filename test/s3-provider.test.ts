import { describe, it, expect, vi, afterEach } from 'vitest'
import { createS3Client, createS3Provider, type S3Client } from '../src/runtime/server/providers/s3'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { useFileStorage } from '../src/runtime/server/utils/storage'
import { rangeStream, streamToBytes } from '../src/runtime/server/utils/objects'
import { runProviderSuite } from './utils/provider-suite'

vi.mock('nitropack/runtime', () => ({ useRuntimeConfig: () => ({}) }))

// Stub aws4fetch's signer so the default S3 client hits our mocked fetch.
vi.mock('aws4fetch', () => ({
  AwsClient: class {
    async sign(url: string, init?: RequestInit) {
      return new Request(url, init)
    }
  },
}))

/** In-memory S3Client that records which keys were read and how keys were listed. */
function memoryClient() {
  const store = new Map<string, Uint8Array>()
  const reads: string[] = []
  const listings: { prefix: string, startAfter?: string }[] = []
  const client: S3Client = {
    async put(key, body) {
      store.set(key, new Uint8Array(body))
    },
    async get(key, range) {
      reads.push(key)
      const data = store.get(key)
      return data ? rangeStream(data, range) : null
    },
    async head(key) {
      return store.has(key)
    },
    async delete(key) {
      store.delete(key)
    },
    async* listKeys(prefix, options) {
      listings.push({ prefix, startAfter: options?.startAfter })
      for (const key of [...store.keys()].sort()) {
        if (key.startsWith(prefix) && (!options?.startAfter || key > options.startAfter)) yield key
      }
    },
  }
  return { client, store, reads, listings }
}

runProviderSuite('s3', () => createS3Provider({ client: memoryClient().client }))

describe('createS3Provider specifics', () => {
  const setup = (prefix?: string) => {
    const memory = memoryClient()
    setFileStorageProvider(createS3Provider({ client: memory.client, prefix }))
    return { ...memory, storage: useFileStorage() }
  }

  it('stores bytes and a JSON metadata object per file', async () => {
    const { storage, store } = setup()
    const put = await storage.put('studio', new TextEncoder().encode('hi'), { contentType: 'text/plain', name: 'a.txt' })
    expect(new TextDecoder().decode(store.get(`studio/data/${put.id}`)!)).toBe('hi')
    expect(JSON.parse(new TextDecoder().decode(store.get(`studio/meta/${put.id}`)!))).toMatchObject({
      size: 2,
      contentType: 'text/plain',
      name: 'a.txt',
      uploadedAt: put.uploadedAt.toISOString(),
    })
  })

  it('head reads only the metadata object', async () => {
    const { storage, reads } = setup()
    const put = await storage.put('studio', new Uint8Array(3))
    reads.length = 0
    await storage.head(put)
    expect(reads).toEqual([`studio/meta/${put.id}`])
  })

  it('pages with start-after instead of rescanning the group', async () => {
    const { storage, listings } = setup()
    for (const id of ['a', 'b', 'c']) await storage.put('studio', new Uint8Array(1), { id })
    listings.length = 0
    const first = await storage.list('studio', { limit: 2 })
    await storage.list('studio', { limit: 2, cursor: first.cursor })
    expect(listings).toEqual([
      { prefix: 'studio/meta/', startAfter: undefined },
      { prefix: 'studio/meta/', startAfter: 'studio/meta/b' },
    ])
  })

  it('namespaces keys with the prefix option', async () => {
    const { storage, store } = setup('media/')
    const put = await storage.put('studio', new Uint8Array(1))
    expect([...store.keys()].sort()).toEqual([`media/studio/data/${put.id}`, `media/studio/meta/${put.id}`])
    expect((await storage.list('studio')).objects).toHaveLength(1)
  })
})

describe('aws4fetch S3 client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const client = () => createS3Client({
    accessKeyId: 'k',
    secretAccessKey: 's',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'bucket',
  })

  it('paginates ListObjectsV2, passing start-after only on the first request', async () => {
    const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>T2</NextContinuationToken>
      <Contents><Key>g/meta/a</Key></Contents><Contents><Key>g/meta/b&amp;c</Key></Contents></ListBucketResult>`
    const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>g/meta/d</Key></Contents></ListBucketResult>`
    const urls: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      const url = new URL(req.url)
      urls.push(url)
      return new Response(url.searchParams.get('continuation-token') === 'T2' ? page2 : page1)
    }))

    const keys: string[] = []
    for await (const key of client().listKeys('g/meta/', { startAfter: 'g/meta/0' })) keys.push(key)

    expect(keys).toEqual(['g/meta/a', 'g/meta/b&c', 'g/meta/d'])
    expect(urls.map(u => [u.searchParams.get('start-after'), u.searchParams.get('continuation-token')])).toEqual([
      ['g/meta/0', null],
      [null, 'T2'],
    ])
  })

  it('streams ranged reads, treating 404 as missing and 416 as empty', async () => {
    const requests: { method: string, range: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      requests.push({ method: req.method, range: req.headers.get('range') })
      if (req.url.endsWith('/missing')) return new Response(null, { status: 404 })
      if (req.headers.get('range') === 'bytes=100-') return new Response(null, { status: 416 })
      return new Response('234', { status: 206 })
    }))

    const s3 = client()
    expect(new TextDecoder().decode(await streamToBytes((await s3.get('g/data/x', { offset: 2, length: 3 }))!))).toBe('234')
    expect(await s3.get('g/data/missing')).toBeNull()
    expect((await streamToBytes((await s3.get('g/data/x', { offset: 100 }))!)).length).toBe(0)
    expect(requests.map(r => r.range)).toEqual(['bytes=2-4', null, 'bytes=100-'])
  })

  it('reports a missing dependency or option clearly', async () => {
    await expect(createS3Client({ accessKeyId: 'k' }).head('x')).rejects.toThrow(/missing required option "secretAccessKey"/)
  })
})
