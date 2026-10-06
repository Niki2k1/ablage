import { describe, it, expect, beforeEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { Storage } from 'unstorage'
import {
  createDrizzleProvider,
  importUnstorageMetadata,
  migrateDrizzleMetadata,
  type BlobStore,
} from '../../src/runtime/server/providers/drizzle'
import { setFileStorageProvider } from '../../src/runtime/server/provider'
import { useFileStorage } from '../../src/runtime/server/utils/storage'
import { rangeStream } from '../../src/runtime/server/utils/objects'
import { runProviderSuite } from './provider-suite'

/** The drizzle-orm entry points the suite needs, from whichever version is under test. */
export interface DrizzleModules {
  pgCore: typeof import('drizzle-orm/pg-core')
  drizzle: typeof import('drizzle-orm/pglite').drizzle
  PGlite: typeof PGlite
  /** Root storage behind the mocked `useStorage()`, with `documents` mounted. */
  storage: Storage
}

function memoryBlobs() {
  const store = new Map<string, Uint8Array>()
  const blobs: BlobStore = {
    async put(key, body) {
      store.set(key, new Uint8Array(body))
    },
    async get(key, range) {
      const data = store.get(key)
      return data ? rangeStream(data, range) : null
    },
    async delete(key) {
      store.delete(key)
    },
  }
  return { blobs, store }
}

const TABLE_SQL = (name: string, metaType: string) => `create table ${name} (
  id text not null,
  group_id text not null,
  metadata ${metaType},
  created_at timestamp,
  updated_at timestamp,
  primary key (group_id, id)
)`

/**
 * Runs the provider contract against real Drizzle + in-memory Postgres
 * (pglite), with a `jsonb` metadata column (queries pushed into SQL) and with
 * plain `json` (the portable in-JS path every other dialect takes), plus the
 * Drizzle-specific behavior.
 */
export function runDrizzleSuite({ pgCore, drizzle, PGlite, storage }: DrizzleModules) {
  const { pgTable, text, json, jsonb, timestamp, primaryKey } = pgCore

  const makeTable = (metaType: 'json' | 'jsonb') => pgTable('ablage_files', {
    id: text('id').notNull(),
    groupId: text('group_id').notNull(),
    metadata: metaType === 'jsonb' ? jsonb('metadata') : json('metadata'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  }, t => [primaryKey({ columns: [t.groupId, t.id] })])

  const freshDb = async (metaType: 'json' | 'jsonb') => {
    const client = new PGlite()
    await client.exec(TABLE_SQL('ablage_files', metaType))
    return { client, db: drizzle({ client }) }
  }

  for (const metaType of ['jsonb', 'json'] as const) {
    runProviderSuite(`drizzle (${metaType})`, async () => {
      const { db } = await freshDb(metaType)
      return createDrizzleProvider({ db, table: makeTable(metaType), blobs: memoryBlobs().blobs })
    })
  }

  describe('createDrizzleProvider specifics', () => {
    let ctx: Awaited<ReturnType<typeof freshDb>> & ReturnType<typeof memoryBlobs> & { storage: ReturnType<typeof useFileStorage> }

    beforeEach(async () => {
      const db = await freshDb('jsonb')
      const blobs = memoryBlobs()
      setFileStorageProvider(createDrizzleProvider({ db: db.db, table: makeTable('jsonb'), blobs: blobs.blobs }))
      ctx = { ...db, ...blobs, storage: useFileStorage() }
    })

    it('stores system fields in the metadata column and fills the timestamp columns', async () => {
      const put = await ctx.storage.put('g', new Uint8Array(3), { contentType: 'image/png', customMetadata: { alt: 'x' } })
      const { rows } = await ctx.client.query<{ metadata: Record<string, unknown>, created_at: Date }>('select metadata, created_at from ablage_files')
      expect(rows[0]!.metadata).toMatchObject({ size: 3, contentType: 'image/png', etag: put.etag, customMetadata: { alt: 'x' } })
      expect(rows[0]!.created_at).toBeInstanceOf(Date)
    })

    it('merges concurrent jsonb metadata updates without losing keys', async () => {
      const put = await ctx.storage.put('g', new Uint8Array(1))
      await Promise.all([
        ctx.storage.updateMeta(put, { customMetadata: { a: 1 } }),
        ctx.storage.updateMeta(put, { customMetadata: { b: 2 } }),
        ctx.storage.updateMeta(put, { name: 'n.txt' }),
      ])
      expect(await ctx.storage.head(put)).toMatchObject({ name: 'n.txt', customMetadata: { a: 1, b: 2 } })
    })

    it('removes the blob when the row insert fails', async () => {
      await ctx.client.exec('drop table ablage_files')
      await expect(ctx.storage.put('g', new Uint8Array(1))).rejects.toThrow()
      expect(ctx.store.size).toBe(0)
    })

    it('migrates rows written by the 0.0.x provider', async () => {
      // 0.0.x stored the flat FileMeta in the metadata column and timestamps in their columns.
      const created = new Date('2026-01-01T00:00:00.000Z')
      await ctx.client.query(
        'insert into ablage_files (id, group_id, metadata, created_at, updated_at) values ($1, $2, $3, $4, $4), ($5, $2, $6, $4, $4)',
        ['f1', 'org:5', JSON.stringify({ name: 'a.pdf', mime: 'application/pdf', type: 'doc', version: 1 }), created, 'gone', JSON.stringify({ name: 'x' })],
      )
      await ctx.blobs.put('org:5/data/f1', new TextEncoder().encode('pdf!'))

      const options = { db: ctx.db, table: makeTable('jsonb'), blobs: ctx.blobs }
      expect(await migrateDrizzleMetadata(options)).toEqual({ migrated: 1, skipped: 0, orphaned: ['org:5/gone'] })
      expect(await migrateDrizzleMetadata(options)).toEqual({ migrated: 0, skipped: 1, orphaned: ['org:5/gone'] })

      expect(await ctx.storage.head({ group: 'org:5', id: 'f1' })).toMatchObject({
        size: 4,
        name: 'a.pdf',
        contentType: 'application/pdf',
        uploadedAt: created,
        updatedAt: created,
        customMetadata: { type: 'doc', version: 1 },
      })
      expect(await ctx.storage.head({ group: 'org:5', id: 'gone' })).toBeNull()
    })

    it('rejects a table missing a required column', async () => {
      const table = pgTable('t', { id: text('id'), groupId: text('group_id') })
      setFileStorageProvider(createDrizzleProvider({ db: ctx.db, table, blobs: ctx.blobs }))
      await expect(useFileStorage().list('g')).rejects.toThrow(/no column "metadata"/)
    })

    it('supports custom column names and tables without timestamps', async () => {
      const table = pgTable('docs', { key: text('key').notNull(), owner: text('owner').notNull(), info: jsonb('info') })
      await ctx.client.exec('create table docs (key text not null, owner text not null, info jsonb, primary key (owner, key))')
      setFileStorageProvider(createDrizzleProvider({
        db: ctx.db,
        table,
        blobs: ctx.blobs,
        columns: { id: 'key', groupId: 'owner', metadata: 'info' },
      }))
      const storage = useFileStorage()
      const put = await storage.put('o', new Uint8Array(2), { name: 'n' })
      expect(await storage.head(put)).toMatchObject({ id: put.id, group: 'o', size: 2, name: 'n' })
    })
  })

  describe('with a Nitro storage mount', () => {
    beforeEach(() => storage.clear('documents'))

    it('stores bytes in the mount, keyed like the unstorage provider', async () => {
      const { db } = await freshDb('jsonb')
      setFileStorageProvider(createDrizzleProvider({ db, table: makeTable('jsonb'), blobs: 'documents' }))
      const put = await useFileStorage().put('g', new TextEncoder().encode('hi'))
      expect(await storage.hasItem(`documents:g:data:${put.id}`)).toBe(true)
      expect(new TextDecoder().decode(await (await useFileStorage().get(put))!.bytes())).toBe('hi')
    })

    it('refuses an unmounted storage instead of falling back to memory', async () => {
      const { db } = await freshDb('jsonb')
      setFileStorageProvider(createDrizzleProvider({ db, table: makeTable('jsonb'), blobs: 'nope' }))
      await expect(useFileStorage().put('g', new Uint8Array(1))).rejects.toThrow(/"nope" is not mounted/)
    })

    it('imports 0.0.x unstorage sidecars into rows', async () => {
      const { db } = await freshDb('jsonb')
      const table = makeTable('jsonb')
      const docs = (await import('unstorage')).prefixStorage(storage, 'documents')
      await docs.setItemRaw('organization:5:data:legacy-1', new TextEncoder().encode('logo'))
      await docs.setItem('organization:5:meta:legacy-1', {
        name: 'logo.svg',
        mime: 'image/svg+xml',
        type: 'image',
        version: 1,
        alt: 'Logo',
        _createdAt: '2026-01-01T00:00:00.000Z',
        _updatedAt: '2026-01-02T00:00:00.000Z',
      })

      expect(await importUnstorageMetadata({ from: 'documents', db, table })).toEqual({ imported: 1, skipped: 0 })
      expect(await importUnstorageMetadata({ from: 'documents', db, table })).toEqual({ imported: 0, skipped: 1 })

      setFileStorageProvider(createDrizzleProvider({ db, table, blobs: 'documents' }))
      const file = await useFileStorage().get({ group: 'organization:5', id: 'legacy-1' })
      expect(file).toMatchObject({
        name: 'logo.svg',
        contentType: 'image/svg+xml',
        size: 4,
        uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        customMetadata: { type: 'image', version: 1, alt: 'Logo' },
      })
      expect(new TextDecoder().decode(await file!.bytes())).toBe('logo')
    })
  })
}
