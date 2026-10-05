import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Storage } from 'unstorage';
import {
  createDrizzleProvider,
  importUnstorageMetadata,
  type BlobStore,
} from '../../src/runtime/server/providers/drizzle';
import { createUnstorageProvider } from '../../src/runtime/server/providers/unstorage';
import type { FileMeta } from '../../src/runtime/types';

/** The drizzle-orm entry points the suite needs, from whichever version is under test. */
export interface DrizzleModules {
  pgCore: typeof import('drizzle-orm/pg-core');
  drizzle: typeof import('drizzle-orm/pglite').drizzle;
  PGlite: typeof PGlite;
  /** Root storage behind the mocked `useStorage()`, with `documents` mounted. */
  storage: Storage;
}

const meta = (over: Partial<FileMeta> = {}): FileMeta => ({
  name: 'file.txt',
  mime: 'text/plain',
  type: 'document',
  version: 1,
  ...over,
});

function memoryBlobs() {
  const store = new Map<string, Buffer>();
  const blobs: BlobStore = {
    async put(key, body) {
      store.set(key, Buffer.from(body));
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return { blobs, store };
}

/**
 * Runs the provider against a real Drizzle + in-memory Postgres (pglite), once
 * with a `jsonb` metadata column (queries pushed into SQL) and once with plain
 * `json` (the portable in-JS path every other dialect takes).
 */
export function runDrizzleSuite({ pgCore, drizzle, PGlite, storage }: DrizzleModules) {
  const { pgTable, text, json, jsonb, timestamp } = pgCore;

  for (const metaType of ['jsonb', 'json'] as const) {
    describe(`metadata as ${metaType}`, () => {
      const files = pgTable('filer_files', {
        id: text('id').primaryKey(),
        groupId: text('group_id').notNull(),
        metadata: metaType === 'jsonb' ? jsonb('metadata') : json('metadata'),
        createdAt: timestamp('created_at'),
        updatedAt: timestamp('updated_at'),
      });

      let setup: ReturnType<typeof memoryBlobs> & {
        provider: ReturnType<typeof createDrizzleProvider>;
        client: PGlite;
      };

      beforeEach(async () => {
        const client = new PGlite();
        await client.exec(`create table filer_files (
          id text primary key,
          group_id text not null,
          metadata ${metaType},
          created_at timestamp,
          updated_at timestamp
        )`);
        const mem = memoryBlobs();
        const db = drizzle({ client });
        setup = { ...mem, client, provider: createDrizzleProvider({ db, table: files, blobs: mem.blobs }) };
      });

      it('create → get round-trips data, metadata and timestamps', async () => {
        const { provider, store } = setup;
        const { id } = await provider.create('studio', Buffer.from('hello'), meta({ name: 'a.png' }));

        const file = await provider.get('studio', id);
        expect(file!.data?.toString()).toBe('hello');
        expect(file!.meta.name).toBe('a.png');
        expect(file!.createdAt).toBeInstanceOf(Date);
        expect(file!.updatedAt).toBeInstanceOf(Date);
        expect(store.has(`studio/data/${id}`)).toBe(true);
        expect((await provider.getData('studio', id))?.toString()).toBe('hello');
      });

      it('head returns the row without reading the blob', async () => {
        const { provider, blobs } = setup;
        const { id } = await provider.create('g', Buffer.from('x'), meta({ name: 'h.png' }));
        const get = blobs.get;
        let blobReads = 0;
        blobs.get = async (key) => {
          blobReads++;
          return get(key);
        };

        const head = await provider.head!('g', id);
        expect(head).toMatchObject({ id, groupId: 'g', meta: { name: 'h.png' } });
        expect(head!.data).toBeUndefined();
        expect(head!.createdAt).toBeInstanceOf(Date);
        expect(await provider.head!('other', id)).toBeNull();
        expect(blobReads).toBe(1); // only the row-less 'other' lookup checks the blob store
      });

      it('scopes get/has/remove by group', async () => {
        const { provider } = setup;
        const { id } = await provider.create('a', Buffer.from('x'), meta());

        expect(await provider.has('a', id)).toBe(true);
        expect(await provider.has('b', id)).toBe(false);
        expect(await provider.get('b', id)).toBeNull();

        await provider.remove('b', id);
        expect(await provider.has('a', id)).toBe(true);
        await provider.remove('a', id);
        expect(await provider.has('a', id)).toBe(false);
        expect(await provider.getData('a', id)).toBeNull();
      });

      it('list returns a group without data', async () => {
        const { provider } = setup;
        await provider.create('g', Buffer.from('1'), meta({ name: 'one' }));
        await provider.create('g', Buffer.from('2'), meta({ name: 'two' }));
        await provider.create('other', Buffer.from('3'), meta());

        const list = await provider.list('g');
        expect(list.map((f) => f.meta.name).sort()).toEqual(['one', 'two']);
        expect(list.every((f) => f.data === undefined && f.groupId === 'g')).toBe(true);
      });

      it('update merges metadata and bumps updatedAt', async () => {
        const { provider } = setup;
        const { id } = await provider.create('g', Buffer.from('x'), meta({ comment: 'keep' }));
        const before = (await provider.get('g', id))!.updatedAt!;

        await new Promise((r) => setTimeout(r, 5));
        await provider.update(id, { version: 2 });

        const after = (await provider.get('g', id))!;
        expect(after.meta).toMatchObject({ version: 2, comment: 'keep', name: 'file.txt' });
        expect(after.updatedAt!.getTime()).toBeGreaterThan(before.getTime());
        expect(await provider.getMeta(id)).toMatchObject({ version: 2 });
      });

      it('update throws for an unknown id', async () => {
        await expect(setup.provider.update('nope', { version: 2 })).rejects.toThrow(/not found/);
      });

      it('findByMeta matches typed values, optionally within a group', async () => {
        const { provider } = setup;
        await provider.create('a', Buffer.from('x'), meta({ ref: 'r1', n: 5 }));
        const { id } = await provider.create('b', Buffer.from('y'), meta({ ref: 'r1', n: 7 }));

        expect((await provider.findByMeta({ key: 'n', value: 7 }))?.id).toBe(id);
        expect(await provider.findByMeta({ key: 'n', value: '7' })).toBeNull();
        expect((await provider.findByMeta({ key: 'ref', value: 'r1', groupId: 'b' }))?.groupId).toBe('b');
        expect(await provider.findByMeta({ key: 'ref', value: 'r2' })).toBeNull();
      });

      it('clear removes a group\'s rows and blobs only', async () => {
        const { provider, store } = setup;
        await provider.create('g', Buffer.from('1'), meta());
        await provider.create('g', Buffer.from('2'), meta());
        const { id } = await provider.create('g2', Buffer.from('3'), meta());

        await provider.clear('g');
        expect(await provider.list('g')).toEqual([]);
        expect([...store.keys()]).toEqual([`g2/data/${id}`]);
      });

      it('removes the blob when the insert fails', async () => {
        const { provider, store, client } = setup;
        await client.exec('drop table filer_files');
        await expect(provider.create('g', Buffer.from('x'), meta())).rejects.toThrow();
        expect(store.size).toBe(0);
      });
    });
  }

  it('rejects a table missing a required column', async () => {
    const table = pgTable('t', { id: text('id'), groupId: text('group_id') });
    const db = drizzle({ client: new PGlite() });
    const provider = createDrizzleProvider({ db, table, blobs: memoryBlobs().blobs });
    await expect(provider.list('g')).rejects.toThrow(/no column "metadata"/);
  });

  it('supports custom column names and tables without timestamps', async () => {
    const table = pgTable('docs', {
      key: text('key').primaryKey(),
      owner: text('owner').notNull(),
      info: jsonb('info'),
    });
    const client = new PGlite();
    await client.exec('create table docs (key text primary key, owner text not null, info jsonb)');
    const provider = createDrizzleProvider({
      db: drizzle({ client }),
      table,
      blobs: memoryBlobs().blobs,
      columns: { id: 'key', groupId: 'owner', metadata: 'info' },
    });

    const { id } = await provider.create('o', Buffer.from('x'), meta({ name: 'n' }));
    const file = await provider.get('o', id);
    expect(file).toMatchObject({ id, groupId: 'o', meta: { name: 'n' } });
    expect(file!.createdAt).toBeUndefined();
  });

  describe('with a Nitro storage mount', () => {
    const table = pgTable('filer_files', {
      id: text('id').primaryKey(),
      groupId: text('group_id').notNull(),
      metadata: jsonb('metadata'),
      createdAt: timestamp('created_at'),
      updatedAt: timestamp('updated_at'),
    });
    const setup = async () => {
      await storage.clear('documents');
      const client = new PGlite();
      await client.exec(`create table filer_files (
        id text primary key, group_id text not null, metadata jsonb,
        created_at timestamp, updated_at timestamp
      )`);
      return drizzle({ client });
    };

    it('stores bytes in the mount, keyed like the unstorage provider', async () => {
      const provider = createDrizzleProvider({ db: await setup(), table, blobs: 'documents' });
      const { id } = await provider.create('g', Buffer.from('hi'), undefined);

      expect(await storage.hasItem(`documents:g:data:${id}`)).toBe(true);
      expect((await provider.getData('g', id))?.toString()).toBe('hi');
    });

    it('refuses an unmounted storage instead of falling back to memory', async () => {
      const provider = createDrizzleProvider({ db: await setup(), table, blobs: 'nope' });
      await expect(provider.create('g', Buffer.from('hi'))).rejects.toThrow(/"nope" is not mounted/);
    });

    it('imports unstorage metadata so existing files keep working', async () => {
      const db = await setup();
      const legacy = createUnstorageProvider('documents');
      const { id } = await legacy.create('organization:5', Buffer.from('logo'), meta({ mime: 'image/svg+xml' }));
      await legacy.create('ticket-1', Buffer.from('x'), meta({ name: 'a.pdf' }));
      const before = (await legacy.get('organization:5', id))!;

      expect(await importUnstorageMetadata({ from: 'documents', db, table })).toEqual({ imported: 2, skipped: 0 });
      expect(await importUnstorageMetadata({ from: 'documents', db, table })).toEqual({ imported: 0, skipped: 2 });

      const provider = createDrizzleProvider({ db, table, blobs: 'documents' });
      const file = (await provider.get('organization:5', id))!;
      expect(file.data?.toString()).toBe('logo');
      expect(file.meta).toEqual(before.meta);
      expect(file.createdAt).toEqual(before.createdAt);
      expect(await provider.getMeta(id)).toMatchObject({ mime: 'image/svg+xml' });
      expect((await provider.list('ticket-1')).map((f) => f.meta.name)).toEqual(['a.pdf']);
    });
  });
}
