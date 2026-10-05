import { describe, it, expect } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import {
  matchesType,
  parseSize,
  readUploadedFile,
  readUploadedFiles,
  type ReadUploadedFilesOptions,
} from '../src/runtime/server/utils/upload'

const png = new File([new Uint8Array(10)], 'logo.png', { type: 'image/png' })
const stl = new File([new Uint8Array(10)], 'model.STL', { type: '' })

function handler(read: (event: Parameters<typeof readUploadedFile>[0]) => Promise<unknown>) {
  return toWebHandler(createApp().use('/', eventHandler(read)))
}

async function post(
  read: (event: Parameters<typeof readUploadedFile>[0]) => Promise<unknown>,
  entries: [string, string | File][],
  headers?: Record<string, string>,
) {
  const form = new FormData()
  for (const [name, value] of entries) form.append(name, value)
  // Report thrown H3 errors as JSON ourselves: plain h3 omits `message`, which
  // Nitro's error handler includes in real apps.
  const res = await handler((event) =>
    read(event).catch((error) => ({ statusCode: error.statusCode, statusMessage: error.statusMessage, message: error.message })),
  )(new Request('http://localhost/', { method: 'POST', body: form, headers }))
  const body = await res.json()
  return { status: body?.statusCode ?? res.status, body }
}

describe('parseSize', () => {
  it('parses 1024-based size strings and passes numbers through', () => {
    expect(parseSize(123)).toBe(123)
    expect(parseSize('500KB')).toBe(500 * 1024)
    expect(parseSize('2 mb')).toBe(2 * 1024 ** 2)
    expect(parseSize('1.5GB')).toBe(1.5 * 1024 ** 3)
    expect(() => parseSize('2 megabytes')).toThrow(/invalid size/)
  })
})

describe('matchesType', () => {
  it('accepts exact types, families, wildcards and extensions', () => {
    expect(matchesType({ name: 'a.png', type: 'image/png' }, ['image/png'])).toBe(true)
    expect(matchesType({ name: 'a.png', type: 'image/png' }, ['image'])).toBe(true)
    expect(matchesType({ name: 'a.png', type: 'image/png' }, ['image/*'])).toBe(true)
    expect(matchesType({ name: 'a.STL', type: 'application/octet-stream' }, ['.stl'])).toBe(true)
    expect(matchesType({ name: 'a.pdf', type: 'application/pdf' }, ['image', '.stl'])).toBe(false)
    // A family must not match a longer type name with the same prefix.
    expect(matchesType({ name: 'a', type: 'imagery/x' }, ['image'])).toBe(false)
  })
})

describe('readUploadedFile', () => {
  const readOne = (options = {}) => (event: Parameters<typeof readUploadedFile>[0]) =>
    readUploadedFile(event, options).then((f) => ({ name: f.name, type: f.type, size: f.size, fields: f.fields }))

  it('returns the file with its metadata and the other form fields', async () => {
    const { status, body } = await post(readOne({ types: ['image'], maxSize: '1KB' }), [['file', png], ['group', 'models']])
    expect(status).toBe(200)
    expect(body).toEqual({ name: 'logo.png', type: 'image/png', size: 10, fields: { group: 'models' } })
  })

  it('defaults a missing type to application/octet-stream and matches by extension', async () => {
    const { body } = await post(readOne({ types: ['.stl'] }), [['file', stl]])
    expect(body.type).toBe('application/octet-stream')
  })

  it('answers 400 without a file', async () => {
    const { status, body } = await post(readOne(), [['group', 'models']])
    expect(status).toBe(400)
    expect(body.message).toMatch(/No file provided/)
  })

  it('answers 413 for too large files', async () => {
    const { status, body } = await post(readOne({ maxSize: 5 }), [['file', png]])
    expect(status).toBe(413)
    expect(body.message).toMatch(/"logo.png" is too large/)
  })

  it('answers 413 from content-length before reading the body', async () => {
    let reached = false
    const read = async (event: Parameters<typeof readUploadedFile>[0]) => {
      const file = await readUploadedFile(event, { maxSize: '1KB' })
      reached = true
      return file.size
    }
    const { status } = await post(read, [['file', png]], { 'content-length': String(10 * 1024 ** 2) })
    expect(status).toBe(413)
    expect(reached).toBe(false)
  })

  it('answers 415 for types that are not accepted', async () => {
    const { status, body } = await post(readOne({ types: ['image/jpeg', '.stl'] }), [['file', png]])
    expect(status).toBe(415)
    expect(body.message).toMatch(/not allowed \(allowed: image\/jpeg, \.stl\)/)
  })

  it('keeps non-ASCII filenames intact in the error message', async () => {
    const file = new File([new Uint8Array(10)], 'Übersicht.pdf', { type: 'application/pdf' })
    const { body } = await post(readOne({ types: ['image'] }), [['file', file]])
    expect(body.message).toContain('"Übersicht.pdf"')
  })

  it('reads a custom field', async () => {
    const { status } = await post(readOne({ field: 'avatar' }), [['avatar', png]])
    expect(status).toBe(200)
  })

  it('answers 400 when more than one file is sent', async () => {
    const { status } = await post(readOne(), [['file', png], ['file', png]])
    expect(status).toBe(400)
  })
})

describe('readUploadedFiles', () => {
  const readMany = (options: ReadUploadedFilesOptions = {}) => (event: Parameters<typeof readUploadedFile>[0]) =>
    readUploadedFiles(event, options).then((files) => files.map((f) => f.name))

  it('returns every file in the field', async () => {
    const { body } = await post(readMany({ types: ['image', '.stl'] }), [['file', png], ['file', stl], ['other', png]])
    expect(body).toEqual(['logo.png', 'model.STL'])
  })

  it('enforces max and validates each file', async () => {
    expect((await post(readMany({ max: 1 }), [['file', png], ['file', png]])).status).toBe(400)
    expect((await post(readMany({ types: ['image'] }), [['file', png], ['file', stl]])).status).toBe(415)
  })
})
