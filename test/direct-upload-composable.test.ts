import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useDirectUpload } from '../src/runtime/composables/direct-upload'
import type { DirectUpload } from '../src/runtime/types'

interface Sent { url: string, size: number, headers: Record<string, string> }
type Reply = { status: number, etag?: string | null } | 'network'

/** Stand-in for the browser's XHR: `reply` decides each PUT's outcome. */
let reply: (sent: Sent) => Reply
let sent: Sent[]

class FakeXhr {
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onloadend: (() => void) | null = null
  status = 0
  statusText = ''
  private url = ''
  private headers: Record<string, string> = {}
  private etag: string | null = null

  open(_method: string, url: string) {
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === 'etag' ? this.etag : null
  }

  abort() {}

  send(body: Blob) {
    const request = { url: this.url, size: body.size, headers: this.headers }
    sent.push(request)
    setTimeout(() => {
      const outcome = reply(request)
      if (outcome === 'network') this.onerror?.()
      else {
        this.upload.onprogress?.({ loaded: body.size })
        this.status = outcome.status
        this.etag = outcome.etag === undefined ? `"${request.url}"` : outcome.etag
        this.onload?.()
      }
      this.onloadend?.()
    })
  }
}

const future = () => new Date(Date.now() + 60_000).toISOString()

const multipart = (sizes: number[], expiresAt = future()): DirectUpload => ({
  type: 'multipart',
  group: 'g',
  id: 'f1',
  token: 'tok',
  expiresAt,
  uploadId: 'u1',
  partSize: sizes[0]!,
  parts: sizes.map((size, index) => ({ number: index + 1, url: `part-${index + 1}`, size })),
})

beforeEach(() => {
  sent = []
  reply = () => ({ status: 200 })
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDirectUpload', () => {
  it('PUTs a small file with the signed headers and completes it through a route', async () => {
    const posts: { url: string, body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify({ id: 'f1', size: 3 }))
    }))
    const single: DirectUpload = { type: 'single', method: 'PUT', url: 'put-url', headers: { 'content-type': 'text/plain' }, group: 'g', id: 'f1', token: 'tok', expiresAt: future() }
    const onSuccess = vi.fn()
    const { start, completed } = useDirectUpload({ start: '/api/start', complete: '/api/complete', onSuccess })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(single)))

    const state = await start(new File(['abc'], 'a.txt', { type: 'text/plain' }))
    expect(state).toMatchObject({ complete: true, progress: 100, result: { id: 'f1', size: 3 } })
    expect(sent).toEqual([{ url: 'put-url', size: 3, headers: { 'content-type': 'text/plain' } }])
    expect(posts.at(-1)).toEqual({ url: '/api/complete', body: { token: 'tok' } })
    expect(completed.value).toHaveLength(1)
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('uploads parts in parallel, retrying failed PUTs, and completes with every ETag', async () => {
    const attempts = new Map<string, number>()
    reply = ({ url }) => {
      attempts.set(url, (attempts.get(url) ?? 0) + 1)
      return url === 'part-2' && attempts.get(url) === 1 ? { status: 503 } : { status: 200 }
    }
    const complete = vi.fn(async () => 'done')
    const { start } = useDirectUpload({ start: async () => multipart([4, 4, 2]), complete, concurrency: 2, retryDelays: [0, 0] })

    const state = await start(new File(['0123456789'], 'v.mp4'))
    expect(state.complete).toBe(true)
    expect(sent.map(s => s.size).sort()).toEqual([2, 4, 4, 4])
    const [input] = complete.mock.calls[0] as unknown as [{ token: string, parts: { number: number, etag: string }[] }]
    expect(input.parts.sort((a, b) => a.number - b.number)).toEqual([
      { number: 1, etag: '"part-1"' },
      { number: 2, etag: '"part-2"' },
      { number: 3, etag: '"part-3"' },
    ])
  })

  it('retry() re-sends only the parts that failed', async () => {
    reply = ({ url }) => url === 'part-2' ? 'network' : { status: 200 }
    const complete = vi.fn(async () => 'done')
    const onError = vi.fn()
    const { start, retry } = useDirectUpload({ start: async () => multipart([4, 4]), complete, concurrency: 1, retryDelays: [0], onError })

    const file = new File(['01234567'], 'v.mp4')
    expect(await start(file)).toMatchObject({ complete: false, error: 'Upload failed: network error' })
    expect(onError).toHaveBeenCalledOnce()

    reply = () => ({ status: 200 })
    sent = []
    expect(await retry(file)).toMatchObject({ complete: true, error: undefined })
    expect(sent.map(s => s.url)).toEqual(['part-2'])
  })

  it('starts over when the upload URLs have expired', async () => {
    reply = () => ({ status: 403 })
    let calls = 0
    const abort = vi.fn(async () => {})
    const { start, retry } = useDirectUpload({
      start: async () => multipart([4], calls++ ? future() : new Date(Date.now() + 5).toISOString()),
      complete: async () => 'done',
      abort,
    })
    const file = new File(['0123'], 'v.mp4')
    expect((await start(file)).error).toMatch(/403/)

    await new Promise(resolve => setTimeout(resolve, 10))
    reply = () => ({ status: 200 })
    expect((await retry(file))?.complete).toBe(true)
    expect(abort).toHaveBeenCalledWith({ token: 'tok' }, file)
    expect(calls).toBe(2)
  })

  it('explains a missing ETag (bucket CORS) and aborts on remove()', async () => {
    reply = () => ({ status: 200, etag: null })
    const abort = vi.fn(async () => {})
    const { start, remove, items } = useDirectUpload({ start: async () => multipart([4]), complete: async () => 'done', abort })
    const file = new File(['0123'], 'v.mp4')
    expect((await start(file)).error).toMatch(/ExposeHeaders/)

    await remove(file)
    expect(abort).toHaveBeenCalledWith({ token: 'tok' }, file)
    expect(items).toEqual({})
  })
})
