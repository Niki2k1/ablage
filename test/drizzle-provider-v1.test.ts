import { describe, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as pgCore from 'drizzle-orm-v1/pg-core';
import { drizzle } from 'drizzle-orm-v1/pglite';
import { runDrizzleSuite } from './utils/drizzle-suite';

// The provider imports `drizzle-orm`; point it at the v1 release candidate.
vi.mock('drizzle-orm', () => import('drizzle-orm-v1'));
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

describe('createDrizzleProvider (drizzle-orm v1)', () => {
  runDrizzleSuite({
    pgCore: pgCore as unknown as typeof import('drizzle-orm/pg-core'),
    drizzle: drizzle as unknown as typeof import('drizzle-orm/pglite').drizzle,
    PGlite,
    storage,
  });
});
