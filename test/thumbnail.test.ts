import { describe, it, expect, vi, afterEach } from 'vitest'
import sharp from 'sharp'
import { generateThumbnail } from '../src/runtime/server/utils/thumbnail'
import { makePdf } from './utils/pdf'

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()

describe('generateThumbnail', () => {
  it('resizes images into the default 300px webp box', async () => {
    const thumb = await generateThumbnail(await solid(1200, 600, '#36c'), 'image/png')
    expect(thumb).toMatchObject({ format: 'webp', mime: 'image/webp', width: 300, height: 150 })
  })

  it('keeps only the first frame of animated images by default', async () => {
    const frames = await sharp([await solid(8, 8, '#f00'), await solid(8, 8, '#00f')], { join: { animated: true } }).gif().toBuffer()
    const thumb = await generateThumbnail(frames, 'image/gif', { width: 4 })
    expect((await sharp(thumb!.data, { animated: true }).metadata()).pages ?? 1).toBe(1)
  })

  it('renders the first PDF page, keeping its aspect ratio and content', async () => {
    const pdf = makePdf(200, 100)
    const thumb = await generateThumbnail(pdf, 'application/pdf', { width: 300, height: 300, format: 'png' })
    expect(thumb).toMatchObject({ format: 'png', width: 300, height: 150 })

    // Left half of the page is red, right half white.
    const { data, info } = await sharp(thumb!.data).raw().toBuffer({ resolveWithObject: true })
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3))
    expect(pixel(50, 75)).toEqual([255, 0, 0])
    expect(pixel(250, 75)).toEqual([255, 255, 255])
  })

  it('leaves the caller\'s PDF bytes intact', async () => {
    const pdf = makePdf()
    const copy = Buffer.from(pdf)
    await generateThumbnail(pdf, 'application/pdf')
    expect(pdf.equals(copy)).toBe(true)
  })

  it('returns null for unsupported types, broken input and missing pages', async () => {
    expect(await generateThumbnail(Buffer.from('hi'), 'text/plain')).toBeNull()
    expect(await generateThumbnail(Buffer.from('not a pdf'), 'application/pdf')).toBeNull()
    expect(await generateThumbnail(Buffer.from('not an image'), 'image/png')).toBeNull()
    expect(await generateThumbnail(makePdf(), 'application/pdf', { page: 2 })).toBeNull()
  })
})

describe('generateThumbnail without the optional dependencies', () => {
  afterEach(() => {
    vi.doUnmock('unpdf')
    vi.resetModules()
  })

  it('returns null and warns once when unpdf is missing', async () => {
    vi.resetModules()
    vi.doMock('unpdf', () => {
      throw Object.assign(new Error('Cannot find package \'unpdf\''), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const { consola } = await import('consola')
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    const { generateThumbnail: fresh } = await import('../src/runtime/server/utils/thumbnail')

    expect(await fresh(makePdf(), 'application/pdf')).toBeNull()
    expect(await fresh(makePdf(), 'application/pdf')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/unpdf/)
  })
})
