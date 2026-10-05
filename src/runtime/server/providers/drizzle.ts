import { randomUUID } from 'node:crypto';
import { useStorage } from 'nitropack/runtime';
import type { Table } from 'drizzle-orm';
import type {
  FileStorageProvider,
  FileMeta,
  StoredFile,
} from '../../../runtime/types';

/**
 * Where the drizzle provider keeps file bytes — the database only holds
 * metadata. The {@link S3Client} from `createS3Client()` satisfies this, and a
 * string is shorthand for a Nitro storage mount name.
 */
export interface BlobStore {
  put(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/**
 * The slice of a Drizzle database the provider calls. Kept loose on purpose:
 * Drizzle's per-dialect builders (pg/mysql/sqlite, v0.x and v1) don't share a
 * common base type, so any `drizzle(...)` instance is accepted here.
 */
export interface DrizzleDatabase {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  select: (...args: any[]) => any;
  insert: (table: any) => any;
  update: (table: any) => any;
  delete: (table: any) => any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export interface DrizzleProviderOptions {
  /** Your Drizzle database instance (any dialect, any async or sync driver). */
  db: DrizzleDatabase;
  /** The table holding file metadata. */
  table: Table;
  /**
   * Where file bytes are stored: a {@link BlobStore} (e.g. `createS3Client()`)
   * or the name of a mounted Nitro storage.
   */
  blobs: BlobStore | string;
  /** Schema property names of the columns used. Unset timestamps are optional. */
  columns?: {
    /** Default: `'id'`. */
    id?: string;
    /** Default: `'groupId'`. */
    groupId?: string;
    /** JSON column. Default: `'metadata'`. */
    metadata?: string;
    /** Set on insert when the table has it. Default: `'createdAt'`. */
    createdAt?: string;
    /** Set on insert/update when the table has it. Default: `'updatedAt'`. */
    updatedAt?: string;
  };
}

type Row = Record<string, unknown>;
type DrizzleOrm = typeof import('drizzle-orm');

const EMPTY_META: FileMeta = { name: '', mime: '', type: '', version: 0 };

function asMeta(value: unknown): FileMeta {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ...EMPTY_META };
    }
  }
  return value && typeof value === 'object' ? (value as FileMeta) : { ...EMPTY_META };
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/** Map a Nitro storage mount onto {@link BlobStore}, refusing unmounted names. */
function storageBlobStore(name: string): BlobStore {
  const storage = () => {
    // An unmounted name silently falls through to the in-memory root driver,
    // which would lose every file on restart.
    if (!useStorage().getMount(name).base) {
      throw new Error(
        `[nuxt-filer] createDrizzleProvider: Nitro storage "${name}" is not mounted. Configure it under \`nitro.storage\`.`,
      );
    }
    return useStorage(name);
  };
  return {
    async put(key, body) {
      await storage().setItemRaw(key, body);
    },
    async get(key) {
      return (await storage().getItemRaw<Buffer>(key)) ?? null;
    },
    async delete(key) {
      await storage().removeItem(key);
    },
  };
}

/**
 * Resolve the configured column names against the table once `drizzle-orm`
 * is loaded (lazily, so apps without it never import it).
 */
function bindTable(table: Table, columnNames: DrizzleProviderOptions['columns'], caller: string) {
  const names = {
    id: 'id',
    groupId: 'groupId',
    metadata: 'metadata',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    ...columnNames,
  };
  const columns = table as unknown as Record<string, unknown>;

  function init(orm: DrizzleOrm) {
    const column = (name: string, required = true) => {
      const value = columns[name];
      if (orm.is(value, orm.Column)) return value;
      if (required) {
        throw new Error(`[nuxt-filer] ${caller}: table has no column "${name}"`);
      }
      return undefined;
    };
    const id = column(names.id)!;
    const groupId = column(names.groupId)!;
    const metadata = column(names.metadata)!;
    return {
      orm,
      id,
      groupId,
      metadata,
      hasCreatedAt: !!column(names.createdAt, false),
      hasUpdatedAt: !!column(names.updatedAt, false),
      jsonb: metadata.columnType === 'PgJsonb',
    };
  }

  let setup: Promise<ReturnType<typeof init>> | undefined;
  const ready = () =>
    (setup ??= import('drizzle-orm')
      .catch(() => {
        throw new Error(
          `[nuxt-filer] ${caller} needs the optional "drizzle-orm" dependency. Install it: npm i drizzle-orm`,
        );
      })
      .then(init));

  return { names, ready };
}

// Same layout as the unstorage (`group:data:id`) and S3 (`group/data/id`)
// providers, so switching metadata to a database keeps existing bytes.
const seg = (value: string) => value.replace(/^\/+|\/+$/g, '');
const blobKey = (groupId: string, id: string) => `${seg(groupId)}/data/${seg(id)}`;

/**
 * Drizzle-backed {@link FileStorageProvider}: metadata lives in a database
 * table, bytes in a {@link BlobStore}. Uses only Drizzle's core query builder,
 * which is unchanged between v0.x and v1.
 *
 * When the metadata column is Postgres `jsonb`, `findByMeta` and `update` run
 * in the database (`@>` containment / `||` merge); other dialects filter and
 * merge in JS.
 */
export function createDrizzleProvider(options: DrizzleProviderOptions): FileStorageProvider {
  const { db, table } = options;
  const blobs = typeof options.blobs === 'string' ? storageBlobStore(options.blobs) : options.blobs;
  const { names, ready } = bindTable(table, options.columns, 'createDrizzleProvider');

  const toStoredFile = (
    c: Awaited<ReturnType<typeof ready>>,
    row: Row,
    data?: Buffer,
  ): StoredFile => ({
    id: String(row[names.id]),
    groupId: String(row[names.groupId]),
    data,
    meta: asMeta(row[names.metadata]),
    createdAt: c.hasCreatedAt ? asDate(row[names.createdAt]) : undefined,
    updatedAt: c.hasUpdatedAt ? asDate(row[names.updatedAt]) : undefined,
  });

  const findRow = async (id: string, groupId?: string): Promise<Row | undefined> => {
    const c = await ready();
    const { eq, and } = c.orm;
    const where = groupId ? and(eq(c.id, id), eq(c.groupId, groupId)) : eq(c.id, id);
    const rows: Row[] = await db.select().from(table).where(where).limit(1);
    return rows[0];
  };

  return {
    async create(groupId, data, meta) {
      const c = await ready();
      const id = randomUUID();
      const key = blobKey(groupId, id);
      const now = new Date();

      await blobs.put(key, data, meta?.mime);
      try {
        await db.insert(table).values({
          [names.id]: id,
          [names.groupId]: groupId,
          [names.metadata]: meta ?? null,
          ...(c.hasCreatedAt ? { [names.createdAt]: now } : {}),
          ...(c.hasUpdatedAt ? { [names.updatedAt]: now } : {}),
        });
      } catch (error) {
        // Don't leave unreachable bytes behind.
        await blobs.delete(key).catch(() => {});
        throw error;
      }
      return { id };
    },

    async get(groupId, id) {
      const c = await ready();
      const [data, row] = await Promise.all([blobs.get(blobKey(groupId, id)), findRow(id, groupId)]);
      if (row) return toStoredFile(c, row, data ?? undefined);
      if (!data) return null;
      return { id, groupId, data, meta: { ...EMPTY_META } };
    },

    async head(groupId, id) {
      const c = await ready();
      const row = await findRow(id, groupId);
      if (row) return toStoredFile(c, row);
      // No row: only bytes stored without metadata (e.g. not yet imported).
      // The blob store has no existence check, so this rare path reads them.
      return (await blobs.get(blobKey(groupId, id))) ? { id, groupId, meta: { ...EMPTY_META } } : null;
    },

    async getData(groupId, id) {
      return blobs.get(blobKey(groupId, id));
    },

    async getMeta(id) {
      const row = await findRow(id);
      return row ? asMeta(row[names.metadata]) : null;
    },

    async list(groupId) {
      const c = await ready();
      const rows: Row[] = await db.select().from(table).where(c.orm.eq(c.groupId, groupId));
      return rows.map((row) => toStoredFile(c, row));
    },

    async update(id, meta) {
      const c = await ready();
      const { eq, sql } = c.orm;
      const stamp = c.hasUpdatedAt ? { [names.updatedAt]: new Date() } : {};

      if (c.jsonb) {
        // Merge in one statement so concurrent updates can't drop each other's keys.
        const rows: Row[] = await db
          .update(table)
          .set({
            [names.metadata]: sql`coalesce(${c.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
            ...stamp,
          })
          .where(eq(c.id, id))
          .returning({ id: c.id });
        if (!rows.length) throw new Error(`File metadata not found: ${id}`);
        return;
      }

      const existing = await findRow(id);
      if (!existing) throw new Error(`File metadata not found: ${id}`);
      await db
        .update(table)
        .set({ [names.metadata]: { ...asMeta(existing[names.metadata]), ...meta }, ...stamp })
        .where(eq(c.id, id));
    },

    async remove(groupId, id) {
      const c = await ready();
      const { eq, and } = c.orm;
      // Row first: if the blob delete then fails, the file is already gone for
      // readers instead of listing with missing bytes.
      await db.delete(table).where(and(eq(c.id, id), eq(c.groupId, groupId)));
      await blobs.delete(blobKey(groupId, id));
    },

    async clear(groupId) {
      const c = await ready();
      const where = c.orm.eq(c.groupId, groupId);
      const rows: Row[] = await db.select({ id: c.id }).from(table).where(where);
      await db.delete(table).where(where);
      await Promise.all(rows.map((row) => blobs.delete(blobKey(groupId, String(row.id)))));
    },

    async has(groupId, id) {
      return !!(await findRow(id, groupId));
    },

    async findByMeta(filter) {
      const c = await ready();
      const { eq, and, sql } = c.orm;
      const inGroup = filter.groupId ? eq(c.groupId, filter.groupId) : undefined;

      if (c.jsonb) {
        const match = sql`${c.metadata} @> ${JSON.stringify({ [filter.key]: filter.value })}::jsonb`;
        const rows: Row[] = await db
          .select()
          .from(table)
          .where(inGroup ? and(inGroup, match) : match)
          .limit(1);
        return rows[0] ? toStoredFile(c, rows[0]) : null;
      }

      const query = db.select().from(table);
      const rows: Row[] = await (inGroup ? query.where(inGroup) : query);
      const row = rows.find((r) => asMeta(r[names.metadata])[filter.key] === filter.value);
      return row ? toStoredFile(c, row) : null;
    },
  };
}

export interface ImportUnstorageMetadataOptions {
  /** Nitro storage mount the unstorage provider wrote to (e.g. `'documents'`). */
  from: string;
  db: DrizzleDatabase;
  table: Table;
  columns?: DrizzleProviderOptions['columns'];
}

/**
 * One-off migration from the unstorage provider: copies its JSON metadata
 * sidecars (`<groupId>:meta:<id>`) into the Drizzle table, keeping ids and
 * timestamps. Bytes stay where they are — point `createDrizzleProvider`'s
 * `blobs` at the same mount. Rows that already exist are skipped, so it is
 * safe to re-run.
 */
export async function importUnstorageMetadata(
  options: ImportUnstorageMetadataOptions,
): Promise<{ imported: number; skipped: number }> {
  const { db, table } = options;
  const { names, ready } = bindTable(table, options.columns, 'importUnstorageMetadata');
  const c = await ready();
  const storage = useStorage(options.from);

  const metaKeys = (await storage.getKeys()).filter((key) => key.includes(':meta:'));
  let imported = 0;

  for (let i = 0; i < metaKeys.length; i += 100) {
    const batch = await Promise.all(
      metaKeys.slice(i, i + 100).map(async (key) => {
        const at = key.lastIndexOf(':meta:');
        const raw = await storage.getItem<FileMeta & { _createdAt?: string; _updatedAt?: string }>(key);
        return { groupId: key.slice(0, at), id: key.slice(at + ':meta:'.length), raw };
      }),
    );

    const ids = batch.map((file) => file.id);
    const existing: Row[] = await db
      .select({ id: c.id })
      .from(table)
      .where(c.orm.inArray(c.id, ids));
    const known = new Set(existing.map((row) => String(row.id)));

    const rows = batch
      .filter((file) => file.raw && !known.has(file.id))
      .map(({ groupId, id, raw }) => {
        const { _createdAt, _updatedAt, ...meta } = raw!;
        return {
          [names.id]: id,
          [names.groupId]: groupId,
          [names.metadata]: meta,
          ...(c.hasCreatedAt ? { [names.createdAt]: asDate(_createdAt) ?? new Date() } : {}),
          ...(c.hasUpdatedAt ? { [names.updatedAt]: asDate(_updatedAt) ?? new Date() } : {}),
        };
      });

    if (rows.length) await db.insert(table).values(rows);
    imported += rows.length;
  }

  return { imported, skipped: metaKeys.length - imported };
}
