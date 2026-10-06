import { describe, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as pgCore from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { runDrizzleSuite } from './utils/drizzle-suite';

const storage = await vi.hoisted(async () => (await import('./utils/nitro-mock')).createNitroStorage());
vi.mock('nitropack/runtime', async () => (await import('./utils/nitro-mock')).nitroRuntimeMock(storage));

describe('createDrizzleProvider (drizzle-orm 0.x)', () => {
  runDrizzleSuite({ pgCore, drizzle, PGlite, storage });
});
