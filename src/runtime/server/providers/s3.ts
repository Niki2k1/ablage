import type { ByteRange, FileObject, FileStorageProvider } from '../../../runtime/types';
import {
  applyPatch,
  bytesToStream,
  serializeObject,
  streamToBytes,
} from '../utils/objects';
import { legacyToObject, parseStoredMetadata, type MigrationResult } from '../utils/legacy';

/**
 * Minimal S3 object-store surface the provider needs. Abstracted so the
 * provider can be unit-tested with an in-memory fake (pass `client`), and so
 * the real implementation (aws4fetch) stays isolated. It also serves as the
 * `blobs` store of `createDrizzleProvider`.
 *
 * `listKeys` MUST list with a server-side prefix and page through every
 * result — unlike unstorage's generic s3 driver, which lists the bucket root
 * and caps at 1000 keys.
 */
export interface S3Client {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** The object's bytes (or a range, clamped to its size) as a stream; `null` if missing. */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` in ascending order, optionally only those after `startAfter`. */
  listKeys(prefix: string, options?: { startAfter?: string }): AsyncGenerator<string, void, unknown>;
}

export interface S3ProviderOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  /** S3 API endpoint, e.g. https://<acct>.r2.cloudflarestorage.com */
  endpoint?: string;
  /** SigV4 region. R2 uses 'auto' (the default). */
  region?: string;
  bucket?: string;
  /** Optional key prefix to namespace files within a shared bucket. */
  prefix?: string;
  /** Inject a custom S3 client (testing or alternative transport). */
  client?: S3Client;
}

/**
 * Map over `items` with at most `limit` promises in flight, preserving order.
 * Reading many metadata objects one by one would cost one round-trip each.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

/**
 * S3-backed {@link FileStorageProvider} (AWS S3, Cloudflare R2, MinIO, …).
 * Bytes and a JSON metadata object are stored separately per file:
 * `${prefix}${group}/data/${id}` and `${prefix}${group}/meta/${id}`. Listing
 * uses S3 prefix listing with `start-after` pagination.
 */
export function createS3Provider(options: S3ProviderOptions): FileStorageProvider {
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';

  let clientPromise: Promise<S3Client> | undefined;
  const getClient = () =>
    (clientPromise ??= options.client
      ? Promise.resolve(options.client)
      : createAwsS3Client(options));

  const dataKey = (group: string, id: string) => `${prefix}${group}/data/${id}`;
  const metaKey = (group: string, id: string) => `${prefix}${group}/meta/${id}`;
  const metaPrefix = (group: string) => `${prefix}${group}/meta/`;

  const readObject = async (client: S3Client, key: string): Promise<FileObject | null> => {
    const body = await client.get(key);
    if (!body) return null;
    // 0.0.x metadata is ignored until migrateS3Metadata() converts it.
    return parseStoredMetadata(new TextDecoder().decode(await streamToBytes(body)))?.current ?? null;
  };
  const writeObject = (client: S3Client, object: FileObject) =>
    client.put(
      metaKey(object.group, object.id),
      new TextEncoder().encode(JSON.stringify(serializeObject(object))),
      'application/json',
    );

  return {
    async head(ref) {
      return readObject(await getClient(), metaKey(ref.group, ref.id));
    },

    async read(ref, range) {
      return (await getClient()).get(dataKey(ref.group, ref.id), range);
    },

    async write(object, data) {
      const client = await getClient();
      // Bytes first: metadata never points at bytes that weren't written.
      await client.put(dataKey(object.group, object.id), data, object.contentType);
      await writeObject(client, object);
    },

    async updateMeta(ref, patch) {
      const client = await getClient();
      const existing = await readObject(client, metaKey(ref.group, ref.id));
      if (!existing) return null;
      const updated = applyPatch(existing, patch);
      await writeObject(client, updated);
      return updated;
    },

    async remove(refs) {
      const client = await getClient();
      await mapWithConcurrency(refs.flatMap((ref) => [metaKey(ref.group, ref.id), dataKey(ref.group, ref.id)]), 16, (key) => client.delete(key));
    },

    async list(group, { limit, cursor, prefix: idPrefix }) {
      const client = await getClient();
      const base = metaPrefix(group);
      const keys: string[] = [];
      // Fetch one key past the page to know whether there's more.
      for await (const key of client.listKeys(base + (idPrefix ?? ''), { startAfter: cursor ? base + cursor : undefined })) {
        // Nested groups share the prefix; only direct children are this group's files.
        if (key.slice(base.length).includes('/')) continue;
        keys.push(key);
        if (keys.length > limit) break;
      }
      const page = keys.slice(0, limit);
      const objects = (await mapWithConcurrency(page, 32, (key) => readObject(client, key)))
        .filter((object): object is FileObject => !!object);
      const hasMore = keys.length > limit;
      return { objects, hasMore, cursor: hasMore ? page[page.length - 1]!.slice(base.length) : undefined };
    },

    async findByMeta({ key, value, group }) {
      const client = await getClient();
      for await (const objectKey of client.listKeys(group ? metaPrefix(group) : prefix)) {
        if (!objectKey.includes('/meta/')) continue;
        const object = await readObject(client, objectKey);
        if (object && object.customMetadata[key] === value) return object;
      }
      return null;
    },
  };
}

/**
 * Upgrade a bucket written by nuxt-filer 0.0.x's S3 provider, in place: every
 * `<group>/meta/<id>` object in the old format is rewritten as a FileObject
 * (`size` and `etag` computed from the data object), and data objects without
 * metadata get one. Data objects are not touched. Safe to re-run. Takes the
 * same options as {@link createS3Provider}.
 */
export async function migrateS3Metadata(options: S3ProviderOptions): Promise<MigrationResult> {
  const client = options.client ?? await createAwsS3Client(options);
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';
  const result: MigrationResult = { migrated: 0, skipped: 0, orphaned: [] };

  const split = (key: string, kind: 'data' | 'meta') => {
    const rel = key.slice(prefix.length);
    const at = rel.lastIndexOf(`/${kind}/`);
    return at > 0 ? { group: rel.slice(0, at), id: rel.slice(at + kind.length + 2) } : null;
  };

  const keys: string[] = [];
  for await (const key of client.listKeys(prefix)) keys.push(key);
  const dataKeys = new Set(keys.filter((key) => split(key, 'data')));
  for (const key of keys) {
    const meta = split(key, 'meta');
    if (meta && !dataKeys.has(`${prefix}${meta.group}/data/${meta.id}`)) result.orphaned.push(key);
  }

  await mapWithConcurrency([...dataKeys], 8, async (dataKey) => {
    const ref = split(dataKey, 'data')!;
    const metaKey = `${prefix}${ref.group}/meta/${ref.id}`;
    const metaBody = await client.get(metaKey);
    const parsed = metaBody ? parseStoredMetadata(new TextDecoder().decode(await streamToBytes(metaBody))) : null;
    if (parsed?.current) {
      result.skipped++;
      return;
    }
    const dataBody = await client.get(dataKey);
    if (!dataBody) return;
    const object = await legacyToObject(ref, parsed?.legacy, await streamToBytes(dataBody));
    await client.put(metaKey, new TextEncoder().encode(JSON.stringify(serializeObject(object))), 'application/json');
    result.migrated++;
  });
  return result;
}

/**
 * Standalone {@link S3Client} (aws4fetch), e.g. as the `blobs` store of
 * `createDrizzleProvider`. Keys are used as-is; `prefix` and `client` don't apply.
 */
export function createS3Client(
  options: Omit<S3ProviderOptions, 'prefix' | 'client'>,
): S3Client {
  let clientPromise: Promise<S3Client> | undefined;
  const getClient = () => (clientPromise ??= createAwsS3Client(options));
  return {
    put: async (key, body, contentType) => (await getClient()).put(key, body, contentType),
    get: async (key, range) => (await getClient()).get(key, range),
    head: async (key) => (await getClient()).head(key),
    delete: async (key) => (await getClient()).delete(key),
    async *listKeys(keyPrefix, listOptions) {
      yield* (await getClient()).listKeys(keyPrefix, listOptions);
    },
  };
}

/** Default {@link S3Client} backed by aws4fetch (SigV4 over fetch). */
async function createAwsS3Client(options: S3ProviderOptions): Promise<S3Client> {
  for (const key of ['accessKeyId', 'secretAccessKey', 'endpoint', 'bucket'] as const) {
    if (!options[key]) {
      throw new Error(`[ablage] createS3Provider: missing required option "${key}"`);
    }
  }

  let AwsClient: typeof import('aws4fetch').AwsClient;
  try {
    ({ AwsClient } = await import('aws4fetch'));
  } catch {
    throw new Error(
      '[ablage] createS3Provider needs the optional "aws4fetch" dependency. Install it: npm i aws4fetch',
    );
  }

  const aws = new AwsClient({
    service: 's3',
    accessKeyId: options.accessKeyId!,
    secretAccessKey: options.secretAccessKey!,
    region: options.region || 'auto',
  });

  const base = `${options.endpoint!.replace(/\/+$/, '')}/${options.bucket}`;
  const objectUrl = (key: string) =>
    `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const signedFetch = (url: string, init?: RequestInit) =>
    aws.sign(url, init).then((req) => fetch(req));

  return {
    async put(key, body, contentType) {
      const res = await signedFetch(objectUrl(key), {
        method: 'PUT',
        body: body as Uint8Array<ArrayBuffer>,
        headers: contentType ? { 'content-type': contentType } : undefined,
      });
      if (!res.ok) {
        throw new Error(`[ablage] S3 PUT ${key}: ${res.status} ${res.statusText}`);
      }
    },
    async get(key, range) {
      if (range?.length === 0) {
        // An empty range can't be expressed as a Range header; just check existence.
        const res = await signedFetch(objectUrl(key), { method: 'HEAD' });
        return res.ok ? bytesToStream(new Uint8Array()) : null;
      }
      const headers = range
        ? { range: `bytes=${range.offset}-${range.length === undefined ? '' : range.offset + range.length - 1}` }
        : undefined;
      const res = await signedFetch(objectUrl(key), { headers });
      if (res.status === 404) return null;
      // Offset past the end: an empty range, as the provider contract asks.
      if (res.status === 416) return bytesToStream(new Uint8Array());
      if (!res.ok) {
        throw new Error(`[ablage] S3 GET ${key}: ${res.status} ${res.statusText}`);
      }
      return res.body ?? bytesToStream(new Uint8Array());
    },
    async head(key) {
      const res = await signedFetch(objectUrl(key), { method: 'HEAD' });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(`[ablage] S3 HEAD ${key}: ${res.status} ${res.statusText}`);
      }
      return true;
    },
    async delete(key) {
      const res = await signedFetch(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error(`[ablage] S3 DELETE ${key}: ${res.status} ${res.statusText}`);
      }
    },
    async *listKeys(keyPrefix, listOptions) {
      let token: string | undefined;
      do {
        const url = new URL(base);
        url.searchParams.set('list-type', '2');
        if (keyPrefix) url.searchParams.set('prefix', keyPrefix);
        if (token) url.searchParams.set('continuation-token', token);
        else if (listOptions?.startAfter) url.searchParams.set('start-after', listOptions.startAfter);

        const res = await signedFetch(url.toString());
        if (!res.ok) {
          throw new Error(`[ablage] S3 LIST ${keyPrefix}: ${res.status} ${res.statusText}`);
        }
        const xml = await res.text();
        for (const key of parseListKeys(xml)) yield key;

        token =
          matchTag(xml, 'IsTruncated') === 'true' ? matchTag(xml, 'NextContinuationToken') : undefined;
      } while (token);
    },
  };
}

function parseListKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) keys.push(decodeXml(match[1]!));
  return keys;
}

function matchTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
