import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { setFileStorageProvider } from '../../src/runtime/server/provider'
import { useFileStorage } from '../../src/runtime/server/utils/storage'
import type { FileStorageProvider } from '../../src/runtime/types'

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder().decode(data)
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('base64url')

/**
 * The behavior every provider must share, exercised through useFileStorage().
 * `create` returns a fresh, empty provider for each test.
 */
export function runProviderSuite(name: string, create: () => FileStorageProvider | Promise<FileStorageProvider>) {
  describe(`${name}: provider contract`, () => {
    let storage: ReturnType<typeof useFileStorage>

    beforeEach(async () => {
      setFileStorageProvider(await create())
      storage = useFileStorage()
    })

    describe('put / head / get', () => {
      it('round-trips bytes, system fields and custom metadata', async () => {
        const data = bytes('hello world')
        const put = await storage.put('docs', data, {
          contentType: 'text/plain',
          name: 'hello.txt',
          cacheControl: 'private, max-age=60',
          customMetadata: { owner: 'u1', n: 5 },
        })
        expect(put).toMatchObject({
          group: 'docs',
          size: 11,
          contentType: 'text/plain',
          etag: sha(data),
          name: 'hello.txt',
          cacheControl: 'private, max-age=60',
          customMetadata: { owner: 'u1', n: 5 },
        })
        expect(put.id).toMatch(/^[0-9a-f-]{36}$/)

        const head = await storage.head(put)
        expect(head).toEqual(put)

        const file = await storage.get(put)
        expect(file).toMatchObject(put)
        expect(text(await file!.bytes())).toBe('hello world')
      })

      it('defaults the content type and accepts Blob, ArrayBuffer and stream bodies', async () => {
        const fromBlob = await storage.put('docs', new Blob(['blob']))
        const fromBuffer = await storage.put('docs', bytes('buffer').buffer)
        const fromStream = await storage.put('docs', new Blob(['stream']).stream())
        expect(fromBlob.contentType).toBe('application/octet-stream')
        expect(text(await (await storage.get(fromBlob))!.bytes())).toBe('blob')
        expect(text(await (await storage.get(fromBuffer))!.bytes())).toBe('buffer')
        expect(text(await (await storage.get(fromStream))!.bytes())).toBe('stream')
      })

      it('stores empty files', async () => {
        const put = await storage.put('docs', new Uint8Array())
        expect(put.size).toBe(0)
        expect((await (await storage.get(put))!.bytes()).length).toBe(0)
      })

      it('returns null for missing files', async () => {
        expect(await storage.head({ group: 'docs', id: 'nope' })).toBeNull()
        expect(await storage.get({ group: 'docs', id: 'nope' })).toBeNull()
      })

      it('reads byte ranges, clamped to the file size', async () => {
        const put = await storage.put('docs', bytes('0123456789'))
        const read = async (offset: number, length?: number) => {
          const file = await storage.get(put, { range: { offset, length } })
          return { text: text(await file!.bytes()), range: file!.range }
        }
        expect(await read(2, 3)).toEqual({ text: '234', range: { offset: 2, length: 3 } })
        expect(await read(7)).toEqual({ text: '789', range: { offset: 7, length: 3 } })
        expect(await read(8, 50)).toEqual({ text: '89', range: { offset: 8, length: 2 } })
        expect(await read(20)).toEqual({ text: '', range: { offset: 10, length: 0 } })
      })

      it('normalizes groups and keeps nested groups apart', async () => {
        const put = await storage.put('/org:5/logos/', bytes('x'))
        expect(put.group).toBe('org:5/logos')
        expect(await storage.head({ group: 'org:5/logos/', id: put.id })).toMatchObject({ id: put.id })
        expect(await storage.head({ group: 'org:5', id: put.id })).toBeNull()
        expect((await storage.list('org:5')).objects).toEqual([])
      })

      it('rejects invalid ids and empty groups', async () => {
        await expect(storage.put('docs', bytes('x'), { id: '../etc' })).rejects.toThrow(/invalid file id/)
        await expect(storage.head({ group: 'docs', id: 'a/b' })).rejects.toThrow(/invalid file id/)
        await expect(storage.put('/', bytes('x'))).rejects.toThrow(/must not be empty/)
      })
    })

    describe('explicit ids', () => {
      it('refuses to replace an existing file without overwrite', async () => {
        await storage.put('avatars', bytes('one'), { id: 'user-1' })
        await expect(storage.put('avatars', bytes('two'), { id: 'user-1' })).rejects.toMatchObject({ statusCode: 409 })
        const replaced = await storage.put('avatars', bytes('two'), { id: 'user-1', overwrite: true })
        expect(text(await (await storage.get(replaced))!.bytes())).toBe('two')
        expect((await storage.list('avatars')).objects).toHaveLength(1)
      })

      it('replaces only on a matching etag with ifMatch', async () => {
        const first = await storage.put('avatars', bytes('one'), { id: 'user-2' })
        await expect(storage.put('avatars', bytes('x'), { id: 'user-2', ifMatch: 'stale' })).rejects.toMatchObject({ statusCode: 412 })
        const second = await storage.put('avatars', bytes('two'), { id: 'user-2', ifMatch: first.etag })
        expect(second.etag).toBe(sha(bytes('two')))
        await expect(storage.put('avatars', bytes('y'), { id: 'missing', ifMatch: first.etag })).rejects.toMatchObject({ statusCode: 412 })
      })

      it('lets the same id exist in different groups', async () => {
        await storage.put('project:1', bytes('a'), { id: 'logo' })
        await storage.put('project:2', bytes('b'), { id: 'logo' })
        expect(text(await (await storage.get({ group: 'project:1', id: 'logo' }))!.bytes())).toBe('a')
        expect(text(await (await storage.get({ group: 'project:2', id: 'logo' }))!.bytes())).toBe('b')
      })
    })

    describe('updateMeta', () => {
      it('merges custom metadata, replaces fields and keeps the content etag', async () => {
        const put = await storage.put('docs', bytes('x'), { name: 'a.txt', customMetadata: { keep: 1, change: 'old' } })
        await new Promise(r => setTimeout(r, 5))
        const updated = await storage.updateMeta(put, { name: 'b.txt', customMetadata: { change: 'new', added: true } })
        expect(updated).toMatchObject({
          name: 'b.txt',
          etag: put.etag,
          size: 1,
          customMetadata: { keep: 1, change: 'new', added: true },
        })
        expect(updated.updatedAt.getTime()).toBeGreaterThan(put.updatedAt.getTime())
        expect(updated.uploadedAt).toEqual(put.uploadedAt)
        expect(await storage.head(put)).toEqual(updated)
      })

      it('throws 404 for missing files', async () => {
        await expect(storage.updateMeta({ group: 'docs', id: 'nope' }, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 })
      })
    })

    describe('remove / clear', () => {
      it('removes one or several files and ignores missing ones', async () => {
        const a = await storage.put('docs', bytes('a'))
        const b = await storage.put('docs', bytes('b'))
        const c = await storage.put('docs', bytes('c'))
        await storage.remove(a)
        await storage.remove([b, { group: 'docs', id: 'missing' }])
        expect(await storage.head(a)).toBeNull()
        expect(await storage.get(b)).toBeNull()
        expect((await storage.list('docs')).objects.map(o => o.id)).toEqual([c.id])
      })

      it('clears a group only', async () => {
        for (let i = 0; i < 3; i++) await storage.put('tmp', bytes(String(i)))
        const kept = await storage.put('keep', bytes('k'))
        await storage.clear('tmp')
        expect((await storage.list('tmp')).objects).toEqual([])
        expect(await storage.head(kept)).not.toBeNull()
      })
    })

    describe('list', () => {
      it('pages through a group in id order', async () => {
        const ids = ['e', 'a', 'd', 'b', 'c']
        for (const id of ids) await storage.put('pages', bytes(id), { id })
        await storage.put('other', bytes('x'), { id: 'aa' })

        const first = await storage.list('pages', { limit: 2 })
        expect(first.objects.map(o => o.id)).toEqual(['a', 'b'])
        expect(first.hasMore).toBe(true)
        const second = await storage.list('pages', { limit: 2, cursor: first.cursor })
        expect(second.objects.map(o => o.id)).toEqual(['c', 'd'])
        const third = await storage.list('pages', { limit: 2, cursor: second.cursor })
        expect(third).toMatchObject({ hasMore: false, cursor: undefined })
        expect(third.objects.map(o => o.id)).toEqual(['e'])

        const all: string[] = []
        for await (const object of storage.listAll('pages', { limit: 2 })) all.push(object.id)
        expect(all).toEqual(['a', 'b', 'c', 'd', 'e'])
      })

      it('filters by id prefix, treating "_" literally', async () => {
        for (const id of ['img_1', 'img_2', 'imgX3', 'doc_1']) await storage.put('pfx', bytes(id), { id })
        expect((await storage.list('pfx', { prefix: 'img_' })).objects.map(o => o.id)).toEqual(['img_1', 'img_2'])
      })
    })

    describe('findByMeta', () => {
      it('matches typed values, optionally within a group', async () => {
        await storage.put('a', bytes('1'), { customMetadata: { ref: 'r1', n: 5 } })
        const b = await storage.put('b', bytes('2'), { customMetadata: { ref: 'r1', n: 7 } })
        expect((await storage.findByMeta('n', 7))?.id).toBe(b.id)
        expect(await storage.findByMeta('n', '7')).toBeNull()
        expect((await storage.findByMeta('ref', 'r1', 'b'))?.group).toBe('b')
        expect(await storage.findByMeta('ref', 'r2')).toBeNull()
      })
    })
  })
}
