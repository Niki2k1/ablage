import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setFileStorageProvider } from '../src/runtime/server/provider'
import { useFileStorage } from '../src/runtime/server/utils/storage'
import { signFileClaims, verifyFileClaims } from '../src/runtime/server/utils/signing'
import { refFromPath } from '../src/runtime/server/utils/route-ref'

const storage = await vi.hoisted(async () => (await import('./utils/nitro-mock')).createNitroStorage())
vi.mock('nitropack/runtime', async () => (await import('./utils/nitro-mock')).nitroRuntimeMock(storage))
const { createUnstorageProvider } = await import('../src/runtime/server/providers/unstorage')

describe('signing', () => {
  const claims = { group: 'org:5/docs', id: 'a-1', expires: 2_000_000_000, download: false }

  it('verifies its own signatures and rejects any change', async () => {
    const sig = await signFileClaims('k', claims)
    expect(await verifyFileClaims('k', claims, sig, 0)).toBe(true)
    expect(await verifyFileClaims('other-key', claims, sig, 0)).toBe(false)
    expect(await verifyFileClaims('k', { ...claims, id: 'a-2' }, sig, 0)).toBe(false)
    expect(await verifyFileClaims('k', { ...claims, download: true }, sig, 0)).toBe(false)
    expect(await verifyFileClaims('k', { ...claims, expires: claims.expires + 1 }, sig, 0)).toBe(false)
  })

  it('rejects expired or malformed expiries', async () => {
    const sig = await signFileClaims('k', claims)
    expect(await verifyFileClaims('k', claims, sig, claims.expires * 1000)).toBe(false)
    expect(await verifyFileClaims('k', { ...claims, expires: Number.NaN }, sig, 0)).toBe(false)
  })
})

describe('refFromPath', () => {
  it('reads nested, encoded groups and rejects invalid refs', () => {
    expect(refFromPath('/_ablage/file/org%3A5/logos/a-1', '/_ablage/file')).toEqual({ group: 'org:5/logos', id: 'a-1' })
    expect(refFromPath('/_ablage/file/only', '/_ablage/file')).toBeNull()
    expect(refFromPath('/_ablage/file/g/..', '/_ablage/file')).toBeNull()
    expect(refFromPath('/elsewhere/g/a', '/_ablage/file')).toBeNull()
  })
})

describe('url helpers', () => {
  let files: ReturnType<typeof useFileStorage>
  beforeEach(async () => {
    await storage.clear('documents')
    setFileStorageProvider(createUnstorageProvider('documents'))
    files = useFileStorage()
  })

  it('url() builds image-route paths from modifiers or transform options', () => {
    expect(() => files.url({ group: 'g', id: 'a b' })).toThrow(/invalid file id/)
    const ok = { group: 'org:5/logos', id: 'logo' }
    expect(files.url(ok)).toBe('/_ablage/image/_/org%3A5/logos/logo')
    expect(files.url(ok, { transform: { w: '200', f: 'webp' } })).toBe('/_ablage/image/w_200,f_webp/org%3A5/logos/logo')
    expect(files.url(ok, { transform: { width: 64, format: 'webp' } })).toBe('/_ablage/image/w_64,fit_inside,f_webp,a/org%3A5/logos/logo')
  })

  it('signedUrl() links verify with the derived key', async () => {
    const link = new URL(await files.signedUrl({ group: 'org:5', id: 'f1' }, { expiresIn: 60, download: true }), 'http://x')
    expect(link.pathname).toBe('/_ablage/file/org%3A5/f1')
    const expires = Number(link.searchParams.get('expires'))
    expect(expires - Date.now() / 1000).toBeGreaterThan(55)
    expect(link.searchParams.get('download')).toBe('1')
    const key = 'test-secret:ablage:signed-url'
    expect(await verifyFileClaims(key, { group: 'org:5', id: 'f1', expires, download: true }, link.searchParams.get('sig')!)).toBe(true)
  })
})
