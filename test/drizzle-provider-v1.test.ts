import { describe, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as pgCore from 'drizzle-orm-v1/pg-core';
import { drizzle } from 'drizzle-orm-v1/pglite';
import { runDrizzleSuite } from './utils/drizzle-suite';

// The provider imports `drizzle-orm`; point it at the v1 release candidate.
vi.mock('drizzle-orm', () => import('drizzle-orm-v1'));
vi.mock('nitropack/runtime', () => ({ useStorage: () => { throw new Error('unused'); } }));

describe('createDrizzleProvider (drizzle-orm v1)', () => {
  runDrizzleSuite({
    pgCore: pgCore as unknown as typeof import('drizzle-orm/pg-core'),
    drizzle: drizzle as unknown as typeof import('drizzle-orm/pglite').drizzle,
    PGlite,
  });
});
