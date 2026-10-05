import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  imageServiceURL,
  parseModifiers,
  signImgproxyPath,
  sourceURL,
  toImgproxyOptions,
  transformToModifiers,
  type ImageServiceConfig,
} from '../src/runtime/server/utils/image-service'

const imgproxy: ImageServiceConfig = {
  service: 'imgproxy',
  route: '/_filer-ipx',
  baseURL: 'https://img.example.com',
}

const b64 = (value: string) => Buffer.from(value).toString('base64url')

describe('imgproxy signing', () => {
  it('matches an HMAC computed with node:crypto', async () => {
    const key = 'deadbeef'
    const salt = 'c0ffee'
    const path = '/rs:fit:200:0/f:webp/abc'
    const expected = createHmac('sha256', Buffer.from(key, 'hex'))
      .update(Buffer.concat([Buffer.from(salt, 'hex'), Buffer.from(path)]))
      .digest('base64url')
    expect(await signImgproxyPath(path, key, salt)).toBe(expected)
  })
})

describe('modifiers', () => {
  it('parses the IPX modifier segment the @nuxt/image provider emits', () => {
    expect(parseModifiers('_')).toEqual({})
    expect(parseModifiers('w_200,f_webp,s_300x200,a')).toEqual({ w: '200', f: 'webp', s: '300x200', a: '' })
  })

  it('maps IPX modifiers to imgproxy options', () => {
    expect(toImgproxyOptions({ w: '200' })).toEqual(['rs:fit:200:0'])
    expect(toImgproxyOptions({ s: '300x200', pos: 'top', q: '80', f: 'jpeg' }))
      .toEqual(['rs:fill:300:200', 'g:no', 'q:80', 'f:jpg'])
    expect(toImgproxyOptions({ width: '100', height: '50', fit: 'contain', b: 'ffffff' }))
      .toEqual(['rs:fit:100:50', 'ex:1', 'bg:ffffff'])
    expect(toImgproxyOptions({ w: '10', enlarge: '', blur: '3' })).toEqual(['rs:fit:10:0', 'el:1', 'bl:3'])
  })

  it('drops modifiers imgproxy has no equivalent for', () => {
    expect(toImgproxyOptions({ grayscale: 'true', tint: 'ff0000', b: 'white' })).toEqual([])
  })

  it('maps upload transform options, keeping the transformImage defaults', () => {
    expect(transformToModifiers({ width: 64, format: 'webp' })).toEqual({ w: '64', fit: 'inside', f: 'webp', a: '' })
    expect(transformToModifiers({ height: 10, withoutEnlargement: false, animated: false, background: '#000' }))
      .toEqual({ h: '10', fit: 'inside', enlarge: '', b: '000' })
  })
})

describe('imageServiceURL', () => {
  const source = sourceURL(imgproxy, 'http://app:3000/', 'organization:5/logos', 'a b')

  it('points the source at the module route, encoding each segment', () => {
    expect(source).toBe('http://app:3000/_filer-ipx/_/organization%3A5/logos/a%20b')
  })

  it('builds unsigned imgproxy URLs without a key', async () => {
    expect(await imageServiceURL(imgproxy, { w: '200', f: 'webp' }, source))
      .toBe(`https://img.example.com/insecure/rs:fit:200:0/f:webp/${b64(source)}`)
  })

  it('builds signed imgproxy URLs', async () => {
    const config = { ...imgproxy, key: 'deadbeef', salt: 'c0ffee' }
    const url = await imageServiceURL(config, { w: '200' }, source)
    const path = `/rs:fit:200:0/${b64(source)}`
    expect(url).toBe(`https://img.example.com/${await signImgproxyPath(path, 'deadbeef', 'c0ffee')}${path}`)
  })

  it('passes IPX modifiers through to a standalone IPX server', async () => {
    const config: ImageServiceConfig = { ...imgproxy, service: 'ipx', baseURL: 'http://ipx:3000' }
    expect(await imageServiceURL(config, { w: '200', a: '' }, source)).toBe(`http://ipx:3000/w_200,a/${source}`)
    expect(await imageServiceURL(config, {}, source)).toBe(`http://ipx:3000/_/${source}`)
  })
})
