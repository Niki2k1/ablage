import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { sendStoredFile } from '../src/runtime/server/utils/send'
import type { FileStorageProvider, StoredFile } from '../src/runtime/types'

const storage = await vi.hoisted(async () => {
  const { createStorage } = await import('unstorage')
  const { default: memoryDriver } = await import('unstorage/drivers/memory')
  const storage = createStorage()
  storage.mount('documents', memoryDriver())
  return storage
})
vi.mock('nitropack/runtime', async () => {
  const { prefixStorage } = await import('unstorage')
  return { useStorage: (base?: string) => (base ? prefixStorage(storage, base) : storage) }
})

const { createUnstorageProvider } = await import('../src/runtime/server/providers/unstorage')

const file: StoredFile = {
  id: 'f1',
  groupId: 'g',
  meta: { name: 'a.txt', mime: 'text/plain', type: 'doc', version: 1 },
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
}
const bytes = Buffer.from('hello')

/** A provider that counts how often the bytes are read. */
function countingProvider(withHead: boolean) {
  const reads = { get: 0, getData: 0 }
  const provider = {
    async get() {
      reads.get++
      return { ...file, data: bytes }
    },
    async getData() {
      reads.getData++
      return bytes
    },
    ...(withHead ? { head: async () => ({ ...file }) } : {}),
  } as unknown as FileStorageProvider
  return { provider, reads }
}

const handler = toWebHandler(
  createApp().use('/file', eventHandler((event) => sendStoredFile(event, 'g', 'f1'))),
)
const request = (init?: RequestInit) => handler(new Request('http://localhost/file', init))

describe('sendStoredFile', () => {
  describe('with a provider that implements head()', () => {
    let reads: ReturnType<typeof countingProvider>['reads']
    beforeEach(() => {
      const counting = countingProvider(true)
      reads = counting.reads
      setFileStorageProvider(counting.provider)
    })

    it('reads the bytes once for a full response', async () => {
      const res = await request()
      expect(await res.text()).toBe('hello')
      expect(res.headers.get('content-length')).toBe('5')
      expect(reads).toEqual({ get: 0, getData: 1 })
    })

    it('answers if-none-match with 304 without reading the bytes', async () => {
      const etag = (await request()).headers.get('etag')!
      reads.getData = 0
      const res = await request({ headers: { 'if-none-match': etag } })
      expect(res.status).toBe(304)
      expect(reads.getData).toBe(0)
    })

    it('answers an echoed if-modified-since with 304 despite millisecond mtimes', async () => {
      const lastModified = (await request()).headers.get('last-modified')!
      expect(lastModified).toBe('Fri, 02 Jan 2026 03:04:05 GMT')
      reads.getData = 0
      const res = await request({ headers: { 'if-modified-since': lastModified } })
      expect(res.status).toBe(304)
      expect(reads.getData).toBe(0)
    })

    it('lets a non-matching if-none-match win over if-modified-since', async () => {
      const lastModified = (await request()).headers.get('last-modified')!
      const res = await request({ headers: { 'if-none-match': 'W/"other"', 'if-modified-since': lastModified } })
      expect(res.status).toBe(200)
    })
  })

  it('reuses the bytes from get() for providers without head()', async () => {
    const { provider, reads } = countingProvider(false)
    setFileStorageProvider(provider)
    expect(await (await request()).text()).toBe('hello')
    expect(reads).toEqual({ get: 1, getData: 0 })
  })

  it('answers 404 for unknown files', async () => {
    setFileStorageProvider({ head: async () => null, get: async () => null } as unknown as FileStorageProvider)
    expect((await request()).status).toBe(404)
  })
})

describe('unstorage provider head()', () => {
  beforeEach(() => storage.clear('documents'))

  it('returns metadata without data, matching get()', async () => {
    const provider = createUnstorageProvider('documents')
    const { id } = await provider.create('g', Buffer.from('x'), file.meta)
    const head = await provider.head!('g', id)
    const full = await provider.get('g', id)
    expect(head!.data).toBeUndefined()
    expect({ ...head, data: full!.data }).toEqual(full)
  })

  it('covers files stored without metadata, and missing ones', async () => {
    const provider = createUnstorageProvider('documents')
    const { id } = await provider.create('g', Buffer.from('x'))
    expect(await provider.head!('g', id)).toMatchObject({ id, groupId: 'g', meta: { name: '' } })
    expect(await provider.head!('g', 'nope')).toBeNull()
  })
})
