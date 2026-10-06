import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { sendStoredFile, type SendStoredFileOptions } from '../src/runtime/server/utils/send'
import { useFileStorage } from '../src/runtime/server/utils/storage'
import type { FileObject, FileStorageProvider } from '../src/runtime/types'

const storage = await vi.hoisted(async () => (await import('./utils/nitro-mock')).createNitroStorage())
vi.mock('nitropack/runtime', async () => (await import('./utils/nitro-mock')).nitroRuntimeMock(storage))

const { createUnstorageProvider } = await import('../src/runtime/server/providers/unstorage')

let file: FileObject
let reads = 0

function serve(options?: SendStoredFileOptions) {
  return toWebHandler(createApp().use('/file', eventHandler(event => sendStoredFile(event, file, options))))
}
const request = (init?: RequestInit, options?: SendStoredFileOptions) =>
  serve(options)(new Request('http://localhost/file', init))

describe('sendStoredFile', () => {
  beforeEach(async () => {
    await storage.clear('documents')
    const provider = createUnstorageProvider('documents')
    reads = 0
    // Count byte reads to prove which paths never touch them.
    setFileStorageProvider({
      ...provider,
      read: (ref, range) => {
        reads++
        return provider.read(ref, range)
      },
    } satisfies FileStorageProvider)
    file = await useFileStorage().put('docs', new TextEncoder().encode('0123456789'), {
      contentType: 'text/plain',
      name: 'Übersicht.txt',
    })
  })

  it('streams the body with headers from the metadata', async () => {
    const res = await request()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('0123456789')
    expect(Object.fromEntries(['content-type', 'content-length', 'etag', 'accept-ranges', 'cache-control'].map(h => [h, res.headers.get(h)]))).toEqual({
      'content-type': 'text/plain',
      'content-length': '10',
      'etag': `"${file.etag}"`,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000',
    })
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="_bersicht.txt"; filename*=UTF-8''%C3%9Cbersicht.txt`)
    expect(reads).toBe(1)
  })

  it('answers HEAD with full headers without reading the bytes', async () => {
    const res = await request({ method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(reads).toBe(0)
  })

  it('answers matching if-none-match (lists, weak tags) and echoed if-modified-since with 304', async () => {
    const lastModified = (await request()).headers.get('last-modified')!
    reads = 0
    expect((await request({ headers: { 'if-none-match': `W/"other", W/"${file.etag}"` } })).status).toBe(304)
    expect((await request({ headers: { 'if-modified-since': lastModified } })).status).toBe(304)
    expect(reads).toBe(0)
    // A non-matching if-none-match wins over if-modified-since.
    expect((await request({ headers: { 'if-none-match': '"other"', 'if-modified-since': lastModified } })).status).toBe(200)
  })

  it('serves single byte ranges', async () => {
    const res = await request({ headers: { range: 'bytes=2-4' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(res.headers.get('content-length')).toBe('3')
    expect(await res.text()).toBe('234')
    expect(await (await request({ headers: { range: 'bytes=7-' } })).text()).toBe('789')
    expect(await (await request({ headers: { range: 'bytes=-2' } })).text()).toBe('89')
    expect(await (await request({ headers: { range: 'bytes=8-99' } })).text()).toBe('89')
  })

  it('answers unsatisfiable ranges with 416 and ignores malformed or multiple ranges', async () => {
    const res = await request({ headers: { range: 'bytes=20-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
    expect((await request({ headers: { range: 'bytes=0-1,4-5' } })).status).toBe(200)
    expect((await request({ headers: { range: 'items=0-1' } })).status).toBe(200)
  })

  it('serves the whole file when if-range no longer matches', async () => {
    expect((await request({ headers: { 'range': 'bytes=0-1', 'if-range': `"${file.etag}"` } })).status).toBe(206)
    expect((await request({ headers: { 'range': 'bytes=0-1', 'if-range': '"stale"' } })).status).toBe(200)
  })

  it('uses the file cacheControl unless maxAge overrides it', async () => {
    file = await useFileStorage().updateMeta(file, { cacheControl: 'private, max-age=5' })
    expect((await request()).headers.get('cache-control')).toBe('private, max-age=5')
    expect((await request({}, { maxAge: 0 })).headers.get('cache-control')).toBe('no-cache')
  })

  it('falls back to the id as download name and answers 404 for missing files', async () => {
    file = await useFileStorage().put('docs', new Uint8Array(1), { id: 'plain' })
    expect((await request({}, { disposition: 'attachment' })).headers.get('content-disposition')).toMatch(/^attachment; filename="plain"/)
    file = { ...file, id: 'missing' }
    expect((await request()).status).toBe(404)
  })
})
