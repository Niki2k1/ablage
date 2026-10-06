import { useStorage } from 'nitropack/runtime';
import type { Table } from 'drizzle-orm';
import type {
  ByteRange,
  FileObject,
  FileRef,
  FileStorageProvider,
  PresignReadOptions,
} from '../../../runtime/types';
import { applyPatch, rangeStream, streamToBytes } from '../utils/objects';
import { legacyToObject, parseStoredMetadata, type MigrationResult } from '../utils/legacy';

/**
 * Where the drizzle provider keeps file bytes — the database only holds
 * metadata. The {@link S3Client} from `createS3Client()` satisfies this, and a
 * string is shorthand for a Nitro storage mount name.
 */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** The bytes (or a range, clamped to their size) as a stream; `null` if missing. */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /** Optional: a presigned GET URL for `key`, enabling direct downloads. */
  presignGet?(key: string, options: PresignReadOptions): Promise<string>;
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
  /**
   * The table holding file metadata. Ids are scoped by group, so make
   * `(groupId, id)` the primary key (or keep explicit ids globally unique).
   */
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
    /** JSON column holding the file's metadata. Default: `'metadata'`. */
    metadata?: string;
    /** Set on insert when the table has it. Default: `'createdAt'`. */
    createdAt?: string;
    /** Set on insert/update when the table has it. Default: `'updatedAt'`. */
    updatedAt?: string;
  };
}

type Row = Record<string, unknown>;
type DrizzleOrm = typeof import('drizzle-orm');

/** What the metadata column stores: every FileObject field except the ref. */
type StoredMetadata = Omit<FileObject, 'group' | 'id' | 'uploadedAt' | 'updatedAt'> & {
  uploadedAt: string;
  updatedAt: string;
};

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    }
    catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function toStored(object: FileObject): StoredMetadata {
  const { group: _group, id: _id, uploadedAt, updatedAt, ...rest } = object;
  return { ...rest, uploadedAt: uploadedAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

/** Map a Nitro storage mount onto {@link BlobStore}, refusing unmounted names. */
function storageBlobStore(name: string): BlobStore {
  const storage = () => {
    // An unmounted name silently falls through to the in-memory root driver,
    // which would lose every file on restart.
    if (!useStorage().getMount(name).base) {
      throw new Error(
        `[ablage] createDrizzleProvider: Nitro storage "${name}" is not mounted. Configure it under \`nitro.storage\`.`,
      );
    }
    return useStorage(name);
  };
  return {
    async put(key, body) {
      await storage().setItemRaw(key, body);
    },
    async get(key, range) {
      const data = await storage().getItemRaw<Uint8Array>(key);
      return data ? rangeStream(new Uint8Array(data), range) : null;
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
        throw new Error(`[ablage] ${caller}: table has no column "${name}"`);
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
          `[ablage] ${caller} needs the optional "drizzle-orm" dependency. Install it: npm i drizzle-orm`,
        );
      })
      .then(init));

  return { names, ready };
}

// Same layout as the unstorage (`group:data:id`) and S3 (`group/data/id`)
// providers, so switching metadata to a database keeps existing bytes.
const blobKey = (group: string, id: string) => `${group}/data/${id}`;

/**
 * Drizzle-backed {@link FileStorageProvider}: metadata lives in a database
 * table, bytes in a {@link BlobStore}. Uses only Drizzle's core query builder,
 * which is unchanged between v0.x and v1.
 *
 * When the metadata column is Postgres `jsonb`, `findByMeta` and `updateMeta`
 * run in the database (`@>` containment / `||` merge); other dialects filter
 * and merge in JS.
 */
export function createDrizzleProvider(options: DrizzleProviderOptions): FileStorageProvider {
  const { db, table } = options;
  const blobs = typeof options.blobs === 'string' ? storageBlobStore(options.blobs) : options.blobs;
  const { names, ready } = bindTable(table, options.columns, 'createDrizzleProvider');

  type Columns = Awaited<ReturnType<typeof ready>>;

  const toObject = (row: Row): FileObject | null => {
    const stored = parseJson(row[names.metadata]) as Partial<StoredMetadata> | null;
    if (!stored || typeof stored.size !== 'number' || typeof stored.etag !== 'string') return null;
    return {
      ...(stored as StoredMetadata),
      group: String(row[names.groupId]),
      id: String(row[names.id]),
      customMetadata: (stored.customMetadata as FileObject['customMetadata']) ?? {},
      uploadedAt: new Date(stored.uploadedAt!),
      updatedAt: new Date(stored.updatedAt!),
    };
  };

  const whereRef = (c: Columns, ref: FileRef) => c.orm.and(c.orm.eq(c.groupId, ref.group), c.orm.eq(c.id, ref.id));

  const findRow = async (c: Columns, ref: FileRef): Promise<Row | undefined> => {
    const rows: Row[] = await db.select().from(table).where(whereRef(c, ref)).limit(1);
    return rows[0];
  };

  const timestamps = (c: Columns, object: FileObject, insert: boolean) => ({
    ...(insert && c.hasCreatedAt ? { [names.createdAt]: object.uploadedAt } : {}),
    ...(c.hasUpdatedAt ? { [names.updatedAt]: object.updatedAt } : {}),
  });

  return {
    async head(ref) {
      const c = await ready();
      const row = await findRow(c, ref);
      return row ? toObject(row) : null;
    },

    read(ref, range) {
      return blobs.get(blobKey(ref.group, ref.id), range);
    },

    async write(object, data) {
      const c = await ready();
      const key = blobKey(object.group, object.id);
      const existed = !!(await findRow(c, object));

      await blobs.put(key, data, object.contentType);
      try {
        if (existed) {
          await db
            .update(table)
            .set({ [names.metadata]: toStored(object), ...timestamps(c, object, false) })
            .where(whereRef(c, object));
        }
        else {
          await db.insert(table).values({
            [names.id]: object.id,
            [names.groupId]: object.group,
            [names.metadata]: toStored(object),
            ...timestamps(c, object, true),
          });
        }
      }
      catch (error) {
        // A new file whose row failed would leave unreachable bytes behind.
        if (!existed) await blobs.delete(key).catch(() => {});
        throw error;
      }
    },

    async updateMeta(ref, patch) {
      const c = await ready();
      const { sql } = c.orm;
      const updatedAt = new Date();

      if (c.jsonb) {
        // One statement, so concurrent updates can't drop each other's keys:
        // replace the top-level fields, then merge customMetadata.
        const { customMetadata = {}, ...fields } = patch;
        const top = { ...fields, updatedAt: updatedAt.toISOString() };
        const rows: Row[] = await db
          .update(table)
          .set({
            [names.metadata]: sql`(coalesce(${c.metadata}, '{}'::jsonb) || ${JSON.stringify(top)}::jsonb) || jsonb_build_object('customMetadata', coalesce(${c.metadata}->'customMetadata', '{}'::jsonb) || ${JSON.stringify(customMetadata)}::jsonb)`,
            ...(c.hasUpdatedAt ? { [names.updatedAt]: updatedAt } : {}),
          })
          .where(whereRef(c, ref))
          .returning();
        return rows[0] ? toObject(rows[0]) : null;
      }

      const row = await findRow(c, ref);
      const existing = row && toObject(row);
      if (!existing) return null;
      const updated = { ...applyPatch(existing, patch), updatedAt };
      await db
        .update(table)
        .set({ [names.metadata]: toStored(updated), ...timestamps(c, updated, false) })
        .where(whereRef(c, ref));
      return updated;
    },

    async remove(refs) {
      const c = await ready();
      // Rows first: if a blob delete then fails, the file is already gone for readers.
      await db.delete(table).where(c.orm.or(...refs.map((ref) => whereRef(c, ref))));
      await Promise.all(refs.map((ref) => blobs.delete(blobKey(ref.group, ref.id))));
    },

    async list(group, { limit, cursor, prefix }) {
      const c = await ready();
      const { and, eq, gt, asc, sql } = c.orm;
      const conditions = [eq(c.groupId, group)];
      if (cursor) conditions.push(gt(c.id, cursor));
      // Ids may contain `_`, a LIKE wildcard; escape it (and `\`, `%`) explicitly.
      if (prefix) conditions.push(sql`${c.id} like ${`${prefix.replace(/[\\%_]/g, '\\$&')}%`} escape '\\'`);
      const rows: Row[] = await db
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(asc(c.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        objects: page.map(toObject).filter((object): object is FileObject => !!object),
        hasMore,
        cursor: hasMore ? String(page[page.length - 1]![names.id]) : undefined,
      };
    },

    async findByMeta({ key, value, group }) {
      const c = await ready();
      const { eq, and, sql } = c.orm;
      const inGroup = group ? eq(c.groupId, group) : undefined;

      if (c.jsonb) {
        const match = sql`${c.metadata} @> ${JSON.stringify({ customMetadata: { [key]: value } })}::jsonb`;
        const rows: Row[] = await db.select().from(table).where(inGroup ? and(inGroup, match) : match).limit(1);
        return rows[0] ? toObject(rows[0]) : null;
      }

      const query = db.select().from(table);
      const rows: Row[] = await (inGroup ? query.where(inGroup) : query);
      for (const row of rows) {
        const object = toObject(row);
        if (object && object.customMetadata[key] === value) return object;
      }
      return null;
    },

    ...(blobs.presignGet
      ? { presignRead: (ref: FileRef, presignOptions: PresignReadOptions) => blobs.presignGet!(blobKey(ref.group, ref.id), presignOptions) }
      : {}),
  };
}

export interface ImportUnstorageMetadataOptions {
  /** Nitro storage mount the 0.0.x unstorage provider wrote to (e.g. `'documents'`). */
  from: string;
  db: DrizzleDatabase;
  table: Table;
  columns?: DrizzleProviderOptions['columns'];
}

/**
 * One-off migration from the 0.0.x unstorage provider: converts its JSON
 * metadata sidecars (`<group>:meta:<id>`) into rows of the Drizzle table,
 * keeping ids and timestamps. `size` and `etag` are computed from the stored
 * bytes, which stay where they are — point `createDrizzleProvider`'s `blobs`
 * at the same mount. Rows that already exist are skipped, so it is safe to
 * re-run.
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

  for (const key of metaKeys) {
    const at = key.lastIndexOf(':meta:');
    const ref = { group: key.slice(0, at), id: key.slice(at + ':meta:'.length) };
    const exists = await db.select({ id: c.id }).from(table)
      .where(c.orm.and(c.orm.eq(c.groupId, ref.group), c.orm.eq(c.id, ref.id))).limit(1);
    if (exists.length) continue;
    const parsed = parseStoredMetadata(await storage.getItem(key));
    const data = await storage.getItemRaw<Uint8Array>(`${ref.group}:data:${ref.id}`);
    if (!parsed || !data) continue;
    const object = parsed.current ?? await legacyToObject(ref, parsed.legacy, new Uint8Array(data));
    await db.insert(table).values({
      [names.id]: ref.id,
      [names.groupId]: ref.group,
      [names.metadata]: toStored(object),
      ...(c.hasCreatedAt ? { [names.createdAt]: object.uploadedAt } : {}),
      ...(c.hasUpdatedAt ? { [names.updatedAt]: object.updatedAt } : {}),
    });
    imported++;
  }

  return { imported, skipped: metaKeys.length - imported };
}

export interface MigrateDrizzleMetadataOptions {
  db: DrizzleDatabase;
  table: Table;
  /** The blob store the 0.0.x provider used (needed to compute `size` and `etag`). */
  blobs: BlobStore | string;
  columns?: DrizzleProviderOptions['columns'];
}

/**
 * Upgrade rows written by nuxt-filer 0.0.x's Drizzle provider, in place: the
 * metadata column's old `FileMeta` becomes a FileObject (`size` and `etag`
 * computed from the stored bytes; timestamps taken from the row's timestamp
 * columns). Rows already converted are skipped, so it is safe to re-run.
 *
 * Change the table's primary key to `(groupId, id)` separately, with your
 * usual schema migrations.
 */
export async function migrateDrizzleMetadata(options: MigrateDrizzleMetadataOptions): Promise<MigrationResult> {
  const { db, table } = options;
  const blobs = typeof options.blobs === 'string' ? storageBlobStore(options.blobs) : options.blobs;
  const { names, ready } = bindTable(table, options.columns, 'migrateDrizzleMetadata');
  const c = await ready();
  const result: MigrationResult = { migrated: 0, skipped: 0, orphaned: [] };

  const rows: Row[] = await db.select().from(table);
  for (const row of rows) {
    const ref = { group: String(row[names.groupId]), id: String(row[names.id]) };
    const parsed = parseStoredMetadata(row[names.metadata]);
    if (parsed?.current) {
      result.skipped++;
      continue;
    }
    const body = await blobs.get(blobKey(ref.group, ref.id));
    if (!body) {
      result.orphaned.push(`${ref.group}/${ref.id}`);
      continue;
    }
    const object = await legacyToObject(ref, parsed?.legacy, await streamToBytes(body), {
      createdAt: row[names.createdAt],
      updatedAt: row[names.updatedAt],
    });
    await db.update(table)
      .set({ [names.metadata]: toStored(object) })
      .where(c.orm.and(c.orm.eq(c.groupId, ref.group), c.orm.eq(c.id, ref.id)));
    result.migrated++;
  }
  return result;
}
