# ablage

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

File storage for Nuxt. Store, read, serve and transform files from your server
routes, on the local filesystem, S3/R2 or a Drizzle-managed database — with one
API.

> **ablage** (German for "filing tray") is the new name of
> [`nuxt-filer`](https://www.npmjs.com/package/nuxt-filer). Upgrading from
> nuxt-filer 0.0.x? See the [migration guide](./MIGRATION.md).

Requires Nuxt ≥ 4.6 and Node ≥ 22.

## Features

- **One storage API** — `useFileStorage()`: `put`, `head`, `get` (streamed, with byte ranges), `list` (paginated), `updateMeta`, `remove`
- **Providers** — local filesystem (default), S3 / Cloudflare R2 / MinIO, Drizzle (metadata in your database, bytes in a blob store), or your own
- **Serving** — `sendStoredFile()` streams files with `etag`/`last-modified` revalidation, `Range` requests and HEAD; `signedUrl()` creates expiring links without a route of your own
- **Images** — `@nuxt/image` provider with on-request transforms (IPX, or an external imgproxy / IPX service), upload-time transforms, and image + PDF thumbnails
- **Uploads** — `readUploadedFile()` validation helper, resumable [tus](https://tus.io) uploads, and direct-to-S3 uploads (presigned, multipart) that never pass through the app server
- **Portable** — server routes run on `nuxt/server`, ready for Nuxt 5

## Setup

```bash
npx nuxi module add ablage
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['ablage'],
  ablage: {
    // Nitro storage mount for file bytes (default: 'documents'), mounted on
    // the local filesystem unless you configure it yourself in `nitro.storage`.
    storageName: 'documents',
    storagePath: '.data/documents',
    // 'unstorage' (default, uses the mount above) or 'custom' (register a
    // provider yourself, see "Providers").
    provider: 'unstorage',
  },
})
```

With the defaults, files are stored under `.data/documents` and nothing else is
needed.

## Usage

Everything below is auto-imported in server code.

### Storing and reading files

Files belong to a **group** (e.g. `avatars`, `project:42`) and have an **id** —
generated, or chosen by you. Together they form a `FileRef`: `{ group, id }`.

```ts
// server/api/avatars.post.ts
export default defineEventHandler(async (event) => {
  const upload = await readUploadedFile(event, { types: ['image'], maxSize: '5MB' })
  const storage = useFileStorage()

  const file = await storage.put('avatars', upload.data, {
    contentType: upload.type,
    name: upload.name,
    customMetadata: { userId: '42' },
  })

  return file // FileObject: group, id, size, contentType, etag, uploadedAt, …
})
```

```ts
const storage = useFileStorage()

await storage.head({ group: 'avatars', id })       // FileObject | null — never reads the bytes
const file = await storage.get({ group: 'avatars', id })
if (file) {
  file.body                                        // ReadableStream<Uint8Array>
  await file.bytes()                               // or the whole file as Uint8Array
}
await storage.get(ref, { range: { offset: 0, length: 1024 } }) // a byte range
```

`put()` options:

| Option | Description |
|---|---|
| `id` | Store at this id instead of a generated UUID (letters, digits, `.`, `_`, `-`) |
| `overwrite` | Replace an existing file at `id`; without it, `put()` throws a 409 |
| `ifMatch` | Replace only if the stored `etag` matches; otherwise a 412 |
| `contentType`, `name`, `cacheControl` | Stored with the file and used when serving it |
| `customMetadata` | Your own JSON-serializable fields |
| `transform` | Process an image first (see [Images](#images)) |

Bodies can be a `Uint8Array`/`Buffer`, `ArrayBuffer`, `Blob` or `ReadableStream`.
`put()` reads the body into memory to compute the size and `etag`; use
[tus](#resumable-uploads-tus) for very large uploads.

### Metadata

Every file has system fields and your `customMetadata`:

```ts
interface FileObject<M = Record<string, unknown>> {
  group: string
  id: string
  size: number          // bytes
  contentType: string   // default 'application/octet-stream'
  etag: string          // SHA-256 of the bytes, base64url
  uploadedAt: Date      // when these bytes were written
  updatedAt: Date       // last change to bytes or metadata
  name?: string
  cacheControl?: string
  width?: number        // images, when known
  height?: number
  customMetadata: M
}
```

```ts
// Shallow-merges customMetadata; other fields are replaced. Throws 404 if missing.
await storage.updateMeta(ref, { name: 'portrait.png', customMetadata: { alt: 'Me' } })

// Typed custom metadata:
const file = await storage.head<{ userId: string }>(ref)
```

### Listing, finding and removing

```ts
const page = await storage.list('avatars', { limit: 50 })        // ordered by id
const next = await storage.list('avatars', { limit: 50, cursor: page.cursor })
await storage.list('docs', { prefix: 'invoice-' })                 // ids starting with…

for await (const file of storage.listAll('avatars')) { /* every file, page by page */ }

await storage.findByMeta('userId', '42', 'avatars') // first match; provider support required

await storage.remove(ref)                           // or an array of refs
await storage.clear('tmp')                          // a whole group
```

### Serving files

`sendStoredFile()` streams a file with `content-type`, `content-length`,
`content-disposition`, `cache-control`, `etag` and `last-modified`. It answers
`if-none-match` / `if-modified-since` with 304 and HEAD requests without reading
the bytes, and serves `Range` requests (206 / 416).

```ts
// server/api/files/[group]/[id].ts
export default defineEventHandler((event) => {
  const { group, id } = getRouterParams(event)
  // check access here
  return sendStoredFile(event, { group, id }, { disposition: 'inline' })
})
```

Options: `disposition` (`'inline'` | `'attachment'`), `filename`, `maxAge` (seconds,
default: the file's `cacheControl`, else one year) and `cacheControl`.

> Name the route file without a method suffix (`[id].ts`, not `[id].get.ts`):
> Nitro routes `.get.ts` files for GET only, so HEAD requests would not reach it.

`createFileResponse(request, ref, options)` is the framework-free core: it takes
a `Request` (or `{ method, headers }`) and returns a `Response`.

### Expiring links

`signedUrl()` creates a time-limited link served by the module itself — no route
of your own:

```ts
const link = await storage.signedUrl({ group: 'invoices', id }, {
  expiresIn: 600,   // seconds, default 3600
  download: true,   // serve as an attachment
})
// → /_ablage/file/invoices/<id>?expires=…&sig=…
```

Links are signed with HMAC-SHA256 using a key derived from Nuxt's `appSecret`,
so set `NUXT_APP_SECRET` (at least 32 characters). Tampered or expired links get
a 403; valid ones are cached privately until they expire.

With the S3 provider and a `publicEndpoint`, `signedUrl()` returns a presigned
S3 `GET` instead, so the bucket serves the bytes (and `Range` requests) directly
and the app server never holds the file. See [S3](#s3--cloudflare-r2--minio).

### Validating uploads

`readUploadedFile()` reads a file from a `multipart/form-data` request and
validates it, throwing 400 (no file), 413 (too large) or 415 (type not allowed):

```ts
const file = await readUploadedFile(event, {
  types: ['image', '.stl', 'application/pdf'], // MIME types, families, extensions
  maxSize: '50MB',                               // bytes or '500KB' / '2MB' / '1GB'
  field: 'file',                                 // form field, default 'file'
})
// → { data, name, type, size, fields } — `fields` holds the other form fields
```

`readUploadedFiles(event, { …, max })` reads several files from one field.
Oversized requests are rejected from `Content-Length` before the body is read.

## Images

### Upload-time transforms

Resize, convert or optimize images while storing them. The stored
`contentType`, `width` and `height` reflect the result:

```ts
await storage.put('avatars', data, {
  contentType: 'image/png',
  transform: { width: 512, height: 512, fit: 'cover', format: 'webp', quality: 80 },
})
```

Options: `width`, `height`, `fit` (`cover` | `contain` | `fill` | `inside` |
`outside`, default `inside`), `withoutEnlargement` (default `true`), `format`
(`webp` | `png` | `jpeg` | `avif` | `gif`), `quality`, `animated` (keep all frames,
default `true`) and `background`. Runs locally with the optional `sharp` peer
dependency, or through an [external image service](#external-image-service).
`transformImage(data, options)` is available standalone.

### Thumbnails and PDF previews

```ts
const thumb = await generateThumbnail(file.data, file.type, { width: 300, height: 200 })
if (thumb) {
  await storage.put('docs', thumb.data, { contentType: thumb.mime, name: `thumb_${file.name}` })
}
```

Images are resized with sharp; PDFs get a page (default: the first) rendered with
[`unpdf`](https://github.com/unjs/unpdf) and `@napi-rs/canvas`. It returns `null`
instead of throwing for unsupported types, unreadable input or missing optional
dependencies. Defaults: a 300×300 `inside` box, `webp`, the first frame of
animated images.

### `@nuxt/image` integration

With `@nuxt/image` installed, the module registers an `ablage` image provider and
an image route that transforms stored images on request:

```vue
<NuxtImg provider="ablage" :src="`${file.group}/${file.id}`" width="200" height="200" fit="cover" format="webp" />
```

URLs look like `/_ablage/image/w_200,h_200,fit_cover,f_webp/<group>/<id>` and are
cached with `etag` / `last-modified` revalidation. Build them on the server with
`storage.url(ref, { transform })`:

```ts
storage.url(ref)                                            // the original
storage.url(ref, { transform: { width: 300, format: 'webp' } })
storage.url(ref, { transform: { s: '300x200', q: '80' } })  // or IPX modifiers
```

> The image route is public, like any `<NuxtImg>` source. Use `signedUrl()` for
> private files.

```ts
ablage: {
  image: {
    enabled: true,           // false to disable; 'force' to register without @nuxt/image
    route: '/_ablage/image', // default
    providerName: 'ablage',  // <NuxtImg provider="…">
  },
},
```

`@nuxt/image`, `ipx` and `sharp` are optional peer dependencies. ipx 3 and 4 are
supported.

### External image service

Image processing can run in a separate service (imgproxy or a standalone
`ipx serve`) instead of this server, so `sharp` and `ipx` aren't needed here:

```ts
ablage: {
  image: { service: 'imgproxy' }, // or 'ipx'; default 'local'
},
```

```bash
NUXT_ABLAGE_IMAGE_BASE_URL=https://img.example.com
NUXT_ABLAGE_IMAGE_KEY=...                     # imgproxy signing key + salt (hex); unsigned when unset
NUXT_ABLAGE_IMAGE_SALT=...
NUXT_ABLAGE_IMAGE_SOURCE_URL=http://app:3000  # how the service reaches this app
```

- `<NuxtImg provider="ablage">` works unchanged: the image route redirects to a
  signed service URL, so the key never reaches the browser.
- The service fetches originals from `/_ablage/image/_/<group>/<id>`; `sourceURL`
  is the origin it uses (e.g. the app on a private Docker network). Without it,
  the request's origin is used.
- Upload-time transforms go through the service too (the original is staged under
  the `_ablage-transform` group and removed afterwards); they require `sourceURL`.
- IPX modifiers are translated to imgproxy options (`w`, `h`, `s`, `fit`,
  `enlarge`, `q`, `f`, `b`, `pos`, `blur`, `sharpen`, `rotate`); others are dropped.
- imgproxy blocks loopback and private source addresses by default; set
  `IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES` / `IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES`
  if `sourceURL` points at one. A standalone IPX needs the host in `--domains`.

## Resumable uploads (tus)

Large or flaky-network uploads can use the [tus protocol](https://tus.io).
Uploads are staged chunk by chunk in a local directory, then *promoted* into the
file storage by one of your own routes, where you check access.

```ts
ablage: {
  tus: {
    enabled: true,
    route: '/_ablage/tus',            // default
    stagingDir: '.data/tus',          // default
    maxSize: 500 * 1024 * 1024,       // optional, bytes
    expiration: 24 * 60 * 60 * 1000,  // optional: purge stale staged uploads
  },
},
```

Client side, `useTusUpload()` wraps [`tus-js-client`](https://github.com/tus/tus-js-client)
with reactive state:

```vue
<script setup lang="ts">
const tus = useTusUpload({
  metadata: file => ({ comment: 'from the web app' }),
  // cleanupOnPageHide: true, // sendBeacon-delete staged uploads on close
})

function onSelect(e: Event) {
  tus.add(Array.from((e.target as HTMLInputElement).files ?? []))
}

async function save() {
  for (const item of tus.completed.value) {
    await $fetch('/api/documents/finalize', { method: 'POST', body: { tusId: item.tusId } })
  }
  tus.clear()
}
</script>
```

Each entry in `tus.items` tracks `progress`, `complete`, `tusId` and `error`;
`tus.remove(name)` aborts and deletes a staged upload, `tus.cancel()` discards
everything. Interrupted uploads resume automatically.

Server side, promote a finished upload. `name` and `contentType` default to the
upload's tus `filename` / `filetype`; the other `put()` options apply:

```ts
// server/api/documents/finalize.post.ts
export default defineEventHandler(async (event) => {
  const { tusId } = await readBody(event)
  return useTusStaging().promote(tusId, 'documents', {
    customMetadata: { kind: 'report' },
    // transform: { width: 1600 },
  })
})
```

`useTusStaging()` also has `info()`, `read()` and `remove()`. To protect or
customize the endpoint (auth, hooks, another datastore), configure `@tus/server`
from a Nitro plugin; the server is created on the first request:

```ts
// server/plugins/tus.ts
export default defineNitroPlugin(() => {
  setTusServerOptions({
    async onIncomingRequest(req) {
      // throw { status_code: 401, body: 'Unauthorized' } to reject
    },
  })
})
```

A `POST <route>/cleanup` sub-route accepts `{ tusIds: string[] }` from
`navigator.sendBeacon` (used by `cleanupOnPageHide`). Staging uses the local
filesystem, independent of the storage provider.

## Direct uploads (S3)

With the S3 provider and a `publicEndpoint`, the browser can upload straight to
the bucket through presigned URLs, so the app server never holds the bytes.
That suits large files and video, and runtimes without a writable disk or with
tight memory limits, where tus can't stage uploads. Files up to the part size
go up with one `PUT`; larger ones as a multipart upload, in parallel parts.

Your own routes start and finish each upload, so you keep control of access
and validation:

```ts
// server/api/uploads/start.post.ts
export default defineEventHandler(async (event) => {
  const { name, type, size } = await readBody(event)
  return useFileStorage().createUpload('videos', {
    name,
    contentType: type,
    size,                       // exact; the store rejects any other length
    maxSize: '2GB',             // 413 before anything is signed
    types: ['video', 'image'],  // 415 otherwise
    customMetadata: { userId: event.context.user.id },
    // expiresIn: 3600,         // lifetime of the URLs, in seconds
    // partSize: 16 * 1024 * 1024,
  })
})

// server/api/uploads/complete.post.ts
export default defineEventHandler(async (event) => {
  const { token, parts } = await readBody(event)
  return useFileStorage().completeUpload(token, { parts })
})

// server/api/uploads/abort.post.ts
export default defineEventHandler(async (event) => {
  await useFileStorage().abortUpload((await readBody(event)).token)
  return null
})
```

```vue
<script setup lang="ts">
const uploads = useDirectUpload({
  start: '/api/uploads/start',        // POSTed { name, type, size }
  complete: '/api/uploads/complete',  // POSTed { token, parts }
  abort: '/api/uploads/abort',        // POSTed { token }
  // concurrency: 4, retryDelays: [0, 1000, 3000, 5000]
})
</script>

<template>
  <input type="file" multiple @change="uploads.add([...($event.target as HTMLInputElement).files!])">
  <div v-for="item in uploads.items" :key="item.file.name">
    {{ item.file.name }}: {{ item.progress.toFixed(0) }}%
    <button v-if="item.error" @click="uploads.retry(item.file)">Retry</button>
  </div>
</template>
```

`start`, `complete` and `abort` also take functions, e.g. to add a group from
your UI. `retry()` (also run when the browser comes back online) re-sends only
the parts that didn't finish; once the URLs have expired it starts over.

- **The token** returned by `createUpload()` is signed and carries the declared
  group, id, name, type and size, so the client can't change them between start
  and finish. `completeUpload()` checks the stored size and only then writes the
  metadata: nothing shows up in `list()` before that.
- **`etag`** of a directly uploaded file is the store's ETag, not a SHA-256.
- **No overwrites**: an explicit `id` must be free (409), because the upload
  would replace the bytes before it completes.
- **Bucket CORS** must allow `PUT` from your origin with the `content-type` and
  `x-amz-meta-*` headers, and expose `ETag` for multipart uploads:

  ```json
  [{
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }]
  ```
- **Abandoned uploads** leave bytes without metadata (never listed) or
  unfinished multipart uploads. Add a lifecycle rule that aborts incomplete
  multipart uploads after a day. Directly uploaded bytes carry
  `x-amz-meta-ablage-direct-upload`, so `migrateS3Metadata()` doesn't adopt
  them as files.

## Providers

A provider persists bytes and metadata. The default `unstorage` provider uses the
`storageName` mount. For other backends, set `provider: 'custom'` and register one
in a Nitro plugin.

### S3 / Cloudflare R2 / MinIO

```ts
// nuxt.config.ts: ablage: { provider: 'custom' }

// server/plugins/storage.ts
export default defineNitroPlugin(() => {
  const { s3 } = useRuntimeConfig()
  setFileStorageProvider(createS3Provider({
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    endpoint: s3.endpoint,   // e.g. https://<account>.r2.cloudflarestorage.com
    region: s3.region,       // R2: 'auto' (default)
    bucket: s3.bucket,
    // prefix: 'media/',     // namespace within a shared bucket
    // publicEndpoint: 'https://s3.example.com', // presigned signedUrl() links
  }))
})
```

Each file is a data object plus a JSON metadata object
(`<group>/data/<id>`, `<group>/meta/<id>`). `head()` reads only the metadata,
ranged reads use S3 `Range` requests, and `list()` pages with S3 prefix listing.
Requires the optional [`aws4fetch`](https://github.com/mhart/aws4fetch) peer
dependency. `createS3Client(options)` gives you the same client on its own (e.g.
as a Drizzle blob store).

#### Direct downloads

Set `publicEndpoint` to the address browsers reach the bucket on, and
`signedUrl()` returns a presigned `GET` for the data object there instead of a
link to the module's file route. It can differ from `endpoint`, e.g. when the
app talks to `http://garage:3900` internally. The link sets `content-type`,
`content-disposition` (`download: true` → attachment with the stored name) and
`cache-control: private` through S3's `response-*` overrides.

- Pass the `FileObject` (as returned by `put()`/`head()`/`list()`) rather than a
  bare `{ group, id }`; otherwise `signedUrl()` reads the metadata first.
- `expiresIn` is capped at 7 days by SigV4; longer values throw.
- The bucket's `etag` and `last-modified` are served, not the module's.
- Links are path-style (`<publicEndpoint>/<bucket>/<key>`). R2 custom domains
  don't accept presigned URLs; use the `r2.cloudflarestorage.com` endpoint.
- A Drizzle provider whose `blobs` is `createS3Client({ ..., publicEndpoint })`
  presigns the same way.

`publicEndpoint` also enables [direct uploads](#direct-uploads-s3).

### Drizzle (metadata in your database)

`createDrizzleProvider` keeps metadata in a table of your
[Drizzle](https://orm.drizzle.team) database (any dialect, drizzle-orm 0.36+ and
v1) and the bytes in a blob store:

```ts
// server/db/schema.ts
import { pgTable, text, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core'

export const files = pgTable('files', {
  id: text('id').notNull(),
  groupId: text('group_id').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at'), // optional
  updatedAt: timestamp('updated_at'), // optional
}, t => [primaryKey({ columns: [t.groupId, t.id] })])
```

```ts
// server/plugins/storage.ts (with ablage: { provider: 'custom' })
import { db } from '../utils/db'
import { files } from '../db/schema'

export default defineNitroPlugin(() => {
  setFileStorageProvider(createDrizzleProvider({
    db,
    table: files,
    blobs: 'documents', // the module's fs mount (= ablage.storageName), or:
    // blobs: createS3Client({ accessKeyId, secretAccessKey, endpoint, bucket }),
    // columns: { id: 'id', groupId: 'groupId', metadata: 'metadata', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }))
})
```

- `columns` maps to the table's schema property names, so an existing table works.
- Ids are unique per group, so make `(groupId, id)` the primary key.
- With a Postgres `jsonb` metadata column, `findByMeta()` and `updateMeta()` run
  in the database (`@>` / `||`, merging concurrent updates safely); add a GIN index
  on `metadata` for large tables. Other column types and dialects work in JS.
- Bytes are stored at `<group>/data/<id>`, like the other providers.
- Requires the optional `drizzle-orm` peer dependency.

### Your own provider

Implement `FileStorageProvider` and register it with `setFileStorageProvider()`.
`useFileStorage()` generates ids, computes size and `etag`, sets timestamps and
checks `overwrite` / `ifMatch`, so a provider only persists what it's given:

```ts
interface FileStorageProvider {
  /** Metadata only, or null. Must not read the bytes. */
  head(ref: FileRef): Promise<FileObject | null>
  /** The bytes (or a range, clamped to the size) as a stream, or null. */
  read(ref: FileRef, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>
  /** Store bytes and metadata, replacing any existing file at the ref. */
  write(object: FileObject, data: Uint8Array): Promise<void>
  /** Apply a patch (customMetadata merged shallowly), bump updatedAt; null if missing. */
  updateMeta(ref: FileRef, patch: FileMetaPatch): Promise<FileObject | null>
  /** Delete files; missing ones are ignored. */
  remove(refs: FileRef[]): Promise<void>
  /** A page of a group's files, ordered by id; `cursor` is the last id of the previous page. */
  list(group: string, options: { limit: number, cursor?: string, prefix?: string }): Promise<ListResult>
  /** Optional: the first file whose customMetadata[key] === value. */
  findByMeta?(filter: { key: string, value: unknown, group?: string }): Promise<FileObject | null>
  /** Optional: a URL serving the bytes straight from the store (signedUrl()). */
  presignRead?(ref: FileRef, options: PresignReadOptions): Promise<string>
  /** Optional: browser-to-store uploads (createUpload()); see ProviderDirectUploads. */
  directUploads?: ProviderDirectUploads
}
```

## Migrating from nuxt-filer

See [MIGRATION.md](./MIGRATION.md) for the API changes and the helpers that
upgrade stored metadata in place (`migrateUnstorageMetadata`, `migrateS3Metadata`,
`migrateDrizzleMetadata`).

## Contribution

<details>
  <summary>Local development</summary>

  ```bash
  pnpm install          # install dependencies
  pnpm run dev:prepare  # generate type stubs
  pnpm run dev          # playground
  pnpm run lint
  pnpm run test
  pnpm run test:types
  ```

</details>

## License

[MIT](./LICENSE)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/ablage/latest.svg?style=flat&colorA=020420&colorB=00DC82
[npm-version-href]: https://npmjs.com/package/ablage
[npm-downloads-src]: https://img.shields.io/npm/dm/ablage.svg?style=flat&colorA=020420&colorB=00DC82
[npm-downloads-href]: https://npm.chart.dev/ablage
[license-src]: https://img.shields.io/npm/l/ablage.svg?style=flat&colorA=020420&colorB=00DC82
[license-href]: https://npmjs.com/package/ablage
[nuxt-src]: https://img.shields.io/badge/Nuxt-020420?logo=nuxt.js
[nuxt-href]: https://nuxt.com
