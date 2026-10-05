import { describe, it, expect, vi, afterEach } from 'vitest';
import { createS3Provider, type S3Client } from '../src/runtime/server/providers/s3';
import type { FileMeta } from '../src/runtime/types';

// Stub aws4fetch's signer so the default S3 client hits our mocked fetch.
vi.mock('aws4fetch', () => ({
  AwsClient: class {
    async sign(url: string, init?: RequestInit) {
      return new Request(url, init);
    }
  },
}));

const meta = (over: Partial<FileMeta> = {}): FileMeta => ({
  name: 'file.txt',
  mime: 'text/plain',
  type: 'document',
  version: 1,
  ...over,
});

/** In-memory S3Client — `listKeys` yields every key under a prefix (no cap). */
function memoryClient() {
  const store = new Map<string, Buffer>();
  const client: S3Client = {
    async put(key, body) {
      store.set(key, Buffer.from(body));
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async head(key) {
      return store.has(key);
    },
    async delete(key) {
      store.delete(key);
    },
    async *listKeys(prefix) {
      for (const key of [...store.keys()].sort()) {
        if (key.startsWith(prefix)) yield key;
      }
    },
  };
  return { client, store };
}

describe('createS3Provider (provider logic)', () => {
  it('create → get round-trips data + metadata + timestamps', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });

    const { id } = await p.create('studio', Buffer.from('hello'), meta({ name: 'a.png', mime: 'image/png' }));
    const file = await p.get('studio', id);

    expect(file).not.toBeNull();
    expect(file!.data?.toString()).toBe('hello');
    expect(file!.meta.name).toBe('a.png');
    expect(file!.meta.mime).toBe('image/png');
    // internal fields are stripped from the returned meta
    expect((file!.meta as Record<string, unknown>)._createdAt).toBeUndefined();
    expect(file!.createdAt).toBeInstanceOf(Date);
    expect(file!.updatedAt).toBeInstanceOf(Date);

    expect((await p.getData('studio', id))?.toString()).toBe('hello');
    expect(await p.has('studio', id)).toBe(true);
  });

  it('head returns metadata without downloading the data object', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    const { id } = await p.create('studio', Buffer.from('hello'), meta({ name: 'a.png' }));

    const gets: string[] = [];
    const get = client.get;
    client.get = async (key) => {
      gets.push(key);
      return get(key);
    };
    const head = await p.head!('studio', id);

    expect(head).toMatchObject({ id, groupId: 'studio', meta: { name: 'a.png' } });
    expect(head!.data).toBeUndefined();
    expect(head!.createdAt).toBeInstanceOf(Date);
    expect(gets).toEqual([`studio/meta/${id}`]);
    expect(await p.head!('studio', 'nope')).toBeNull();
  });

  it('list returns only the group, ignoring other groups and root objects', async () => {
    const { client, store } = memoryClient();
    const p = createS3Provider({ client });

    // simulate a shared bucket with unrelated root objects (like migrated images)
    store.set('152391.jpg', Buffer.from('x'));
    store.set('logo.png', Buffer.from('x'));

    await p.create('studio', Buffer.from('1'), meta({ name: 'one' }));
    await p.create('studio', Buffer.from('2'), meta({ name: 'two' }));
    await p.create('other', Buffer.from('3'), meta({ name: 'three' }));

    const studio = await p.list('studio');
    expect(studio).toHaveLength(2);
    expect(studio.map((f) => f.meta.name).sort()).toEqual(['one', 'two']);
    expect(studio.every((f) => f.data === undefined)).toBe(true); // list omits data

    expect(await p.list('other')).toHaveLength(1);
    expect(await p.list('empty')).toHaveLength(0);
  });

  it('list returns all files past the 1000-key boundary (no cap)', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });

    for (let i = 0; i < 1001; i++) {
      await p.create('studio', Buffer.from(String(i)), meta({ name: `f${i}` }));
    }
    expect(await p.list('studio')).toHaveLength(1001);
  });

  it('update merges metadata and bumps updatedAt', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    const { id } = await p.create('studio', Buffer.from('x'), meta({ name: 'orig', comment: 'c' }));

    await p.update(id, { comment: 'updated' });
    const file = await p.get('studio', id);
    expect(file!.meta.comment).toBe('updated');
    expect(file!.meta.name).toBe('orig'); // preserved
  });

  it('update throws for an unknown id', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    await expect(p.update('nope', { comment: 'x' })).rejects.toThrow(/not found/i);
  });

  it('remove and clear delete data + metadata', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    const { id } = await p.create('studio', Buffer.from('x'), meta());
    await p.remove('studio', id);
    expect(await p.get('studio', id)).toBeNull();
    expect(await p.has('studio', id)).toBe(false);

    await p.create('studio', Buffer.from('1'), meta());
    await p.create('other', Buffer.from('2'), meta());
    await p.clear('studio');
    expect(await p.list('studio')).toHaveLength(0);
    expect(await p.list('other')).toHaveLength(1); // other group untouched
  });

  it('findByMeta and getMeta locate by metadata/id', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    const { id } = await p.create('studio', Buffer.from('x'), meta({ name: 'needle.png' }));

    const found = await p.findByMeta({ key: 'name', value: 'needle.png', groupId: 'studio' });
    expect(found?.id).toBe(id);
    expect(found?.groupId).toBe('studio');

    const foundAnyGroup = await p.findByMeta({ key: 'name', value: 'needle.png' });
    expect(foundAnyGroup?.id).toBe(id);

    expect((await p.getMeta(id))?.name).toBe('needle.png');
    expect(await p.getMeta('missing')).toBeNull();
  });

  it('tolerates a leading slash in the group id (IPX passes /group)', async () => {
    const { client } = memoryClient();
    const p = createS3Provider({ client });
    const { id } = await p.create('studio', Buffer.from('x'), meta({ name: 'leading.png' }));

    // the IPX integration hands the group through as `/studio`
    expect((await p.get('/studio', id))?.meta.name).toBe('leading.png');
    expect((await p.getData('/studio', id))?.toString()).toBe('x');
    expect(await p.has('/studio', id)).toBe(true);
    expect(await p.list('/studio')).toHaveLength(1);
  });

  it('namespaces keys with the prefix option', async () => {
    const { client, store } = memoryClient();
    const p = createS3Provider({ client, prefix: 'media' });
    const { id } = await p.create('studio', Buffer.from('x'), meta());

    expect([...store.keys()]).toContain(`media/studio/data/${id}`);
    expect([...store.keys()]).toContain(`media/studio/meta/${id}`);
    expect(await p.list('studio')).toHaveLength(1);
  });
});

describe('createS3Provider (aws4fetch client pagination)', () => {
  const page1 = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>TOKEN2</NextContinuationToken>
    <Contents><Key>studio/meta/id1</Key></Contents>
    <Contents><Key>studio/meta/id2</Key></Contents>
  </ListBucketResult>`;
  const page2 = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>studio/meta/id3</Key></Contents>
  </ListBucketResult>`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paginates ListObjectsV2 with continuation tokens and parses keys', async () => {
    const metaJson = (name: string) =>
      JSON.stringify({ name, mime: 'image/png', type: 'image', version: 1, _createdAt: '', _updatedAt: '' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        if (url.searchParams.get('list-type') === '2') {
          const body = url.searchParams.get('continuation-token') === 'TOKEN2' ? page2 : page1;
          return new Response(body, { status: 200 });
        }
        // object GET for each meta key
        const id = url.pathname.split('/').pop()!;
        return new Response(metaJson(id), { status: 200 });
      }),
    );

    const p = createS3Provider({
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'bucket',
    });

    const files = await p.list('studio');
    expect(files.map((f) => f.id).sort()).toEqual(['id1', 'id2', 'id3']); // spans both pages
  });
});
