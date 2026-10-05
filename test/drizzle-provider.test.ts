import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as pgCore from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { createDrizzleProvider } from '../src/runtime/server/providers/drizzle';
import { runDrizzleSuite } from './utils/drizzle-suite';

const storage = await vi.hoisted(async () => {
  const { createStorage } = await import('unstorage');
  const { default: memoryDriver } = await import('unstorage/drivers/memory');
  const storage = createStorage();
  storage.mount('documents', memoryDriver());
  return storage;
});
vi.mock('nitropack/runtime', async () => {
  const { prefixStorage } = await import('unstorage');
  return { useStorage: (base?: string) => (base ? prefixStorage(storage, base) : storage) };
});

describe('createDrizzleProvider (drizzle-orm 0.x)', () => {
  runDrizzleSuite({ pgCore, drizzle, PGlite });

  describe('blobs as a Nitro storage mount name', () => {
    const table = pgCore.pgTable('filer_files', {
      id: pgCore.text('id').primaryKey(),
      groupId: pgCore.text('group_id').notNull(),
      metadata: pgCore.jsonb('metadata'),
    });
    const setup = async () => {
      const client = new PGlite();
      await client.exec('create table filer_files (id text primary key, group_id text not null, metadata jsonb)');
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
  });
});
