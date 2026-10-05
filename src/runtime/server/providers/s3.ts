import type {
  FileStorageProvider,
  FileMeta,
  StoredFile,
} from '../../../runtime/types';

/**
 * Minimal S3 object-store surface the provider needs. Abstracted so the
 * provider can be unit-tested with an in-memory fake (pass `client`), and so
 * the real implementation (aws4fetch) stays isolated.
 *
 * `listKeys` MUST list with a server-side prefix and paginate through every
 * page — that's the whole point of this provider over unstorage's generic s3
 * driver, which lists the bucket root and caps at 1000 keys.
 */
export interface S3Client {
  put(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): AsyncGenerator<string, void, unknown>;
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

type InternalMeta = FileMeta & { _createdAt?: string; _updatedAt?: string };

/**
 * Map over `items` with at most `limit` promises in flight, preserving order.
 * Used to read many meta objects concurrently instead of one-at-a-time — on a
 * remote store (R2/S3) the per-object round-trip latency dominates, so a
 * sequential `for await` over N files is ~N × RTT. Bounded so a huge group
 * doesn't open thousands of sockets at once.
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
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * S3-backed {@link FileStorageProvider}. Binary data and a JSON metadata
 * sidecar are stored as separate objects per file, mirroring the built-in
 * unstorage provider's semantics — but `list`/`findByMeta` use real S3 prefix
 * listing with continuation pagination, so a group is correctly scoped even
 * inside a large shared bucket.
 *
 * Key layout: `${prefix}${groupId}/data/${id}` and `${prefix}${groupId}/meta/${id}`.
 */
export function createS3Provider(options: S3ProviderOptions): FileStorageProvider {
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';

  let clientPromise: Promise<S3Client> | undefined;
  const getClient = () =>
    (clientPromise ??= options.client
      ? Promise.resolve(options.client)
      : createAwsS3Client(options));

  // Strip leading/trailing slashes so callers can pass `studio` or `/studio`
  // interchangeably (the IPX integration hands group ids through with a leading
  // slash). Without this, keys like `/studio/data/x` miss the stored object.
  const seg = (value: string) => value.replace(/^\/+|\/+$/g, '');
  const dataKey = (groupId: string, id: string) => `${prefix}${seg(groupId)}/data/${seg(id)}`;
  const metaKey = (groupId: string, id: string) => `${prefix}${seg(groupId)}/meta/${seg(id)}`;
  const metaPrefix = (groupId: string) => `${prefix}${seg(groupId)}/meta/`;

  /** `${prefix}${groupId}/meta/${id}` → groupId (groups may contain '/'). */
  const groupIdFromMetaKey = (key: string) => {
    const rel = key.slice(prefix.length);
    return rel.slice(0, rel.lastIndexOf('/meta/'));
  };
  const idFromKey = (key: string) => key.slice(key.lastIndexOf('/') + 1);

  const readMeta = async (client: S3Client, key: string): Promise<InternalMeta | null> => {
    const raw = await client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString('utf8')) as InternalMeta;
    } catch {
      return null;
    }
  };

  const toStoredFile = (
    id: string,
    groupId: string,
    meta: InternalMeta | null,
    data?: Buffer,
  ): StoredFile => ({
    id,
    groupId,
    data: data ?? undefined,
    meta: stripInternal(meta),
    createdAt: meta?._createdAt ? new Date(meta._createdAt) : undefined,
    updatedAt: meta?._updatedAt ? new Date(meta._updatedAt) : undefined,
  });

  return {
    async create(groupId, data, meta) {
      const client = await getClient();
      const id = globalThis.crypto.randomUUID();

      await client.put(dataKey(groupId, id), data, meta?.mime);

      if (meta) {
        const now = new Date().toISOString();
        await client.put(
          metaKey(groupId, id),
          Buffer.from(JSON.stringify({ ...meta, _createdAt: now, _updatedAt: now })),
          'application/json',
        );
      }

      return { id };
    },

    async get(groupId, id) {
      const client = await getClient();
      const [data, meta] = await Promise.all([
        client.get(dataKey(groupId, id)),
        readMeta(client, metaKey(groupId, id)),
      ]);
      if (!data && !meta) return null;
      return toStoredFile(id, groupId, meta, data ?? undefined);
    },

    async head(groupId, id) {
      const client = await getClient();
      const meta = await readMeta(client, metaKey(groupId, id));
      if (!meta && !(await client.head(dataKey(groupId, id)))) return null;
      return toStoredFile(id, groupId, meta);
    },

    async getData(groupId, id) {
      return (await getClient()).get(dataKey(groupId, id));
    },

    async getMeta(id) {
      // No groupId: scan meta objects (bounded by `prefix` when set). The
      // serving path uses get/getData (which carry a groupId), so this is the
      // only non-group-scoped lookup.
      const client = await getClient();
      for await (const key of client.listKeys(prefix)) {
        if (key.endsWith(`/meta/${id}`)) {
          return stripInternal(await readMeta(client, key));
        }
      }
      return null;
    },

    async list(groupId) {
      const client = await getClient();
      // Enumerate the group's meta keys (cheap paginated LIST), then read every
      // meta object in parallel. The previous sequential read was one blocking
      // GET per file, so listing a group cost ~N round-trips to the store.
      const keys: string[] = [];
      for await (const key of client.listKeys(metaPrefix(groupId))) keys.push(key);
      const metas = await mapWithConcurrency(keys, 32, (key) => readMeta(client, key));
      const files: StoredFile[] = [];
      for (let i = 0; i < keys.length; i++) {
        const meta = metas[i];
        if (!meta) continue;
        files.push(toStoredFile(idFromKey(keys[i]!), groupId, meta));
      }
      return files;
    },

    async update(id, meta) {
      const client = await getClient();
      for await (const key of client.listKeys(prefix)) {
        if (!key.endsWith(`/meta/${id}`)) continue;
        const existing = (await readMeta(client, key)) ?? ({} as InternalMeta);
        await client.put(
          key,
          Buffer.from(
            JSON.stringify({ ...existing, ...meta, _updatedAt: new Date().toISOString() }),
          ),
          'application/json',
        );
        return;
      }
      throw new Error(`File metadata not found: ${id}`);
    },

    async remove(groupId, id) {
      const client = await getClient();
      await Promise.all([
        client.delete(dataKey(groupId, id)),
        client.delete(metaKey(groupId, id)),
      ]);
    },

    async clear(groupId) {
      const client = await getClient();
      for await (const key of client.listKeys(`${prefix}${seg(groupId)}/`)) {
        await client.delete(key);
      }
    },

    async has(groupId, id) {
      return (await getClient()).head(dataKey(groupId, id));
    },

    async findByMeta(filter) {
      const client = await getClient();
      const scanPrefix = filter.groupId ? metaPrefix(filter.groupId) : prefix;
      for await (const key of client.listKeys(scanPrefix)) {
        if (!key.includes('/meta/')) continue;
        const meta = await readMeta(client, key);
        if (!meta) continue;
        if (meta[filter.key] === filter.value) {
          return toStoredFile(idFromKey(key), groupIdFromMetaKey(key), meta);
        }
      }
      return null;
    },
  };
}

function stripInternal(meta: InternalMeta | null): FileMeta {
  if (!meta) return { name: '', mime: '', type: '', version: 0 };
  const { _createdAt, _updatedAt, ...rest } = meta;
  return rest as FileMeta;
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
    get: async (key) => (await getClient()).get(key),
    head: async (key) => (await getClient()).head(key),
    delete: async (key) => (await getClient()).delete(key),
    async *listKeys(keyPrefix) {
      yield* (await getClient()).listKeys(keyPrefix);
    },
  };
}

/** Default {@link S3Client} backed by aws4fetch (SigV4 over fetch). */
async function createAwsS3Client(options: S3ProviderOptions): Promise<S3Client> {
  for (const key of ['accessKeyId', 'secretAccessKey', 'endpoint', 'bucket'] as const) {
    if (!options[key]) {
      throw new Error(`[nuxt-filer] createS3Provider: missing required option "${key}"`);
    }
  }

  let AwsClient: typeof import('aws4fetch').AwsClient;
  try {
    ({ AwsClient } = await import('aws4fetch'));
  } catch {
    throw new Error(
      '[nuxt-filer] createS3Provider needs the optional "aws4fetch" dependency. Install it: npm i aws4fetch',
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
        body: body as BodyInit,
        headers: contentType ? { 'content-type': contentType } : undefined,
      });
      if (!res.ok) {
        throw new Error(`[nuxt-filer] S3 PUT ${key}: ${res.status} ${res.statusText}`);
      }
    },
    async get(key) {
      const res = await signedFetch(objectUrl(key));
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`[nuxt-filer] S3 GET ${key}: ${res.status} ${res.statusText}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    async head(key) {
      const res = await signedFetch(objectUrl(key), { method: 'HEAD' });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(`[nuxt-filer] S3 HEAD ${key}: ${res.status} ${res.statusText}`);
      }
      return true;
    },
    async delete(key) {
      const res = await signedFetch(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error(`[nuxt-filer] S3 DELETE ${key}: ${res.status} ${res.statusText}`);
      }
    },
    async *listKeys(keyPrefix) {
      let token: string | undefined;
      do {
        const url = new URL(base);
        url.searchParams.set('list-type', '2');
        if (keyPrefix) url.searchParams.set('prefix', keyPrefix);
        if (token) url.searchParams.set('continuation-token', token);

        const res = await signedFetch(url.toString());
        if (!res.ok) {
          throw new Error(`[nuxt-filer] S3 LIST ${keyPrefix}: ${res.status} ${res.statusText}`);
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
