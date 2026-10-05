import { describe, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as pgCore from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
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
  runDrizzleSuite({ pgCore, drizzle, PGlite, storage });
});
