# ablage

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> **ablage** is the new name of [`nuxt-filer`](https://www.npmjs.com/package/nuxt-filer), starting with v0.1.0. v0.1.0 also changes the API (see [#21](https://github.com/Niki2k1/ablage/issues/21)); a migration guide follows with the release.

File storage module for Nuxt (≥ 4.6, Node ≥ 22). Provides a server-side `useFileStorage()` composable with pluggable storage backends — from zero-config local filesystem to custom providers with separate metadata databases and external file sync.

## Features

- **Pluggable provider architecture** — built-in unstorage (default), S3 and Drizzle providers, or bring your own
- **File versioning** — built-in version tracking, latest-version filtering, and duplicate detection
- **External file sync** — two-way sync with external systems (Jira, SharePoint, etc.) via optional provider interface
- **Zero-config default** — works out of the box with local filesystem storage, no database required
- **Auto-imported** — `useFileStorage()`, types, and provider utilities are auto-imported in server context
- **Group-based organization** — files are organized by `groupId` (project, ticket, order, etc.)
- **`@nuxt/image` integration** — when `@nuxt/image` is installed, an IPX endpoint is wired up automatically so `<NuxtImg provider="ablage" src="<groupId>/<id>" />` returns optimized variants of stored files
- **Upload-time image processing** — optionally run images through Sharp when storing them (resize, format-convert, optimize, preserve animation) via a per-call `transform` option or the standalone `transformImage()` util
- **Resumable uploads (tus)** — opt-in [tus](https://tus.io) endpoint backed by `@tus/server`, a client-side `useTusUpload()` composable, and `useTusStaging().promote()` to move finished uploads into the file storage

## Quick Setup

```bash
npx nuxi module add ablage
```

## Configuration

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['ablage'],
  ablage: {
    // Nitro storage mount name (default: 'documents'). Mounted on the local fs
    // for every provider unless you configure it yourself under `nitro.storage`.
    storageName: 'documents',
    // Base path for fs-lite driver (default: '.data/documents')
    storagePath: '.data/documents',
    // 'unstorage' (built-in) or 'custom' (bring your own provider)
    provider: 'unstorage',
  },
})
```

## Usage

### Basic — Upload and retrieve files

```ts
// server/api/files/[groupId].post.ts
export default defineEventHandler(async (event) => {
  const groupId = getRouterParam(event, 'groupId')!
  const body = await readMultipartFormData(event)
  const file = body![0]!

  const storage = useFileStorage()

  const id = await storage.upload(groupId, file.data, {
    meta: {
      name: file.filename || 'unnamed',
      mime: file.type || 'application/octet-stream',
      type: 'document',
      version: 1,
    },
  })

  return { id, groupId }
})
```

```ts
// server/api/files/[groupId].get.ts
export default defineEventHandler(async (event) => {
  const groupId = getRouterParam(event, 'groupId')!
  const storage = useFileStorage()

  return await storage.list(groupId)
})
```

### Upload-time image processing

Pass a `transform` option to `upload()` to process an image **before it is stored** — useful for normalizing user uploads or rehosted remote images to a capped size and compact format. The processed bytes are what gets stored, and the file's `meta.mime` / `meta.width` / `meta.height` are updated to match the result.

```ts
const id = await storage.upload(groupId, file.data, {
  meta: { name: file.filename!, mime: file.type!, type: 'image', version: 1 },
  transform: {
    width: 128,
    height: 128,
    format: 'webp', // convert to webp
    // fit: 'inside' (default), withoutEnlargement: true (default),
    // quality, background, animated (default true)
  },
})
```

You can also call the util directly (e.g. for images fetched server-side):

```ts
const res = await transformImage(buffer, { width: 64, format: 'webp' })
// res: { data: Buffer, mime: 'image/webp', format: 'webp', width: 64, height: 64 }
```

**`transform` / `transformImage()` options**

| Option | Description |
|---|---|
| `width`, `height` | Target box in px (combined with `fit`) |
| `fit` | Resize fit mode (`inside` default, or `cover`/`contain`/`fill`/`outside`) |
| `withoutEnlargement` | Never scale up beyond the original (default `true`) |
| `format` | Output format: `webp` / `png` / `jpeg` / `avif` / `gif` (default: keep input) |
| `quality` | Output quality `1-100` for lossy formats |
| `animated` | Preserve all frames of animated inputs (default `true`; only retained when `format` is `webp`/`gif`) |
| `background` | Background used when flattening transparency |

> Image processing requires the optional [`sharp`](https://sharp.pixelplumbing.com/) peer dependency. Install it (`npm i sharp`) only if you use `transform` / `transformImage()` — calling them without `sharp` throws a clear error. Without a `transform`, `upload()` stores the raw bytes unchanged and needs no extra dependency.

### Thumbnails and PDF previews with `generateThumbnail()`

Builds a preview image from a stored file: images are resized with Sharp, PDFs
get a page (the first by default) rendered and then resized. It returns
`null` instead of throwing for unsupported types, unreadable input, or missing
optional dependencies, so it can run on every upload:

```ts
const file = await readUploadedFile(event)
const id = await storage.upload('docs', file.data, { meta: { name: file.name, mime: file.type, type: 'document', version: 1 } })

const thumb = await generateThumbnail(file.data, file.type, { width: 300, height: 200 })
if (thumb) {
  await storage.upload('docs', thumb.data, {
    meta: { name: `thumb_${file.name}`, mime: thumb.mime, type: 'thumbnail', version: 1 },
  })
}
```

- Options are those of `transformImage()` plus `page` (PDF page, default `1`).
  Defaults: a 300×300 `inside` box, `webp`, and the first frame only for
  animated images (`animated: true` keeps animation).
- Requires `sharp`; PDFs additionally need [`unpdf`](https://github.com/unjs/unpdf)
  and `@napi-rs/canvas` (`npm i unpdf @napi-rs/canvas`). All are optional peer
  dependencies; when one is missing, a warning is logged once and `null` returned.
- On-request transforms (the IPX route, or imgproxy) can't render PDFs, so a
  stored preview like this is the way to show one.

### `useFileStorage()` API

| Method | Description |
|---|---|
| `upload(groupId, data, options?)` | Store a file, returns its ID. `options.transform` runs the bytes through Sharp first (see above) |
| `list(groupId)` | List all files in a group |
| `get(groupId, id)` | Get a file with data and metadata |
| `head(groupId, id)` | Get a file's metadata and timestamps without reading its bytes |
| `getData(groupId, id)` | Get raw binary data only |
| `getMeta(id)` | Get metadata only. Searches all groups, which is slow on large stores — prefer `head(groupId, id)` |
| `updateMeta(id, meta)` | Deep-merge metadata update |
| `remove(groupId, id)` | Delete a file |
| `clear(groupId)` | Delete all files in a group |
| `has(groupId, id)` | Check if a file exists |
| `findByMeta(key, value, groupId?)` | Find a file by metadata field |
| `checkDuplicate(groupId, key, value)` | Check if a duplicate exists |
| `getLatestVersions(groupId)` | Get latest version of each file by name |
| `getNextVersionNumber(files, name)` | Calculate next version number |
| `external?.sync(groupId, id)` | Sync with external system (if provider supports it) |
| `external?.push(groupId, id, data, meta)` | Push to external system |
| `external?.pull(groupId, ref)` | Pull from external system |

### Validating uploads with `readUploadedFile()`

Reads a file from a `multipart/form-data` request and validates it, throwing a
400 (no file), 413 (too large) or 415 (type not allowed) with a message naming
the file and the limit:

```ts
// server/api/models.post.ts
export default defineEventHandler(async (event) => {
  const file = await readUploadedFile(event, {
    types: ['image', '.stl', '.3mf', 'application/pdf'],
    maxSize: '50MB',
  })
  const id = await useFileStorage().upload(file.fields.group ?? 'uploads', file.data, {
    meta: { name: file.name, mime: file.type, type: 'model', version: 1 },
  })
  return { id }
})
```

- `types` uses the syntax of the HTML `accept` attribute: exact MIME types
  (`'image/png'`), families (`'image'` or `'image/*'`) and extensions
  (`'.stl'`). Extensions help for formats browsers send without a MIME type.
- `maxSize` takes bytes or a string like `'500KB'`, `'2MB'` (1024-based). An
  oversized request is rejected from its `Content-Length` before the body is read.
- `field` picks the form field (default `'file'`); the result's `fields` holds
  the other, non-file form fields.
- `readUploadedFiles(event, { ..., max })` reads several files from the same field.

### Serving raw files with `sendStoredFile()`

The IPX route serves **images** with full HTTP caching. For everything else — original PDFs, non-image downloads, the unprocessed bytes of any file — `sendStoredFile()` streams a stored file back through an H3 event with the same revalidation story.

```ts
// server/api/files/[groupId]/[id].get.ts
export default defineEventHandler((event) => {
  const { groupId, id } = getRouterParams(event)
  return sendStoredFile(event, groupId, id) // 404 if missing
})
```

It sets `content-type` from `meta.mime`, a `content-disposition` filename from `meta.name`, and `cache-control` / `last-modified` / `etag`, honoring `if-modified-since` / `if-none-match` (`304`) — just like the IPX route. `HEAD` requests get the headers without a body.

```ts
sendStoredFile(event, groupId, id, {
  disposition: 'attachment', // force a download ('inline' is the default)
  filename: 'invoice-2026.pdf', // override the download name (default: meta.name)
  maxAge: 3600, // cache-control max-age in seconds (default: 1 year; 0 = no-cache)
})
```

`sendStoredFile` is auto-imported in your server routes — no need to import it.

## `@nuxt/image` Integration

If `@nuxt/image` is installed alongside `ablage`, the module automatically registers an `ablage` image provider and an IPX endpoint that pulls bytes from your storage provider, runs them through Sharp, and returns the result.

```vue
<template>
  <NuxtImg
    provider="ablage"
    :src="`${groupId}/${fileId}`"
    width="200"
    height="200"
    fit="cover"
    format="webp"
  />
</template>
```

Generated URLs look like `/_ablage/image/w_200,h_200,fit_cover,format_webp/<groupId>/<fileId>` and are served with `cache-control: max-age=...`, `last-modified`, and `etag` for `if-modified-since` / `if-none-match` revalidation.

The integration can be configured or turned off:

```ts
ablage: {
  image: {
    enabled: true,            // false to disable; 'force' to register without @nuxt/image
    route: '/_ablage/image',     // base path for the IPX endpoint
    providerName: 'ablage',    // name used in <NuxtImg provider="..." />
  },
},
```

`@nuxt/image` and `ipx` are declared as optional peer dependencies — they only need to be installed if you want to use this integration. Both ipx 3 and ipx 4 (pulled in by `@nuxt/image` 2.1+) are supported.

### External image service (imgproxy / standalone IPX)

Image processing can run in a separate service instead of this server, so
`sharp` and `ipx` aren't needed here and one service can serve many apps:

```ts
ablage: {
  image: {
    service: 'imgproxy', // or 'ipx' for a standalone `npx ipx serve`; default 'local'
  },
},
```

```bash
NUXT_ABLAGE_IMAGE_BASE_URL=https://img.example.com
NUXT_ABLAGE_IMAGE_KEY=...           # imgproxy signing key + salt (hex); unsigned URLs when unset
NUXT_ABLAGE_IMAGE_SALT=...
NUXT_ABLAGE_IMAGE_SOURCE_URL=http://app:3000   # how the service reaches this app
```

- `<NuxtImg provider="ablage">` works unchanged. The image route redirects to a
  signed service URL, so the signing key never reaches the browser.
- The service fetches originals from `/_ablage/image/_/<groupId>/<fileId>`, which
  serves the stored bytes. `sourceURL` is the origin it uses for that — e.g. the
  app's address on a private Docker network. Without it, the request's origin
  is used.
- Upload-time transforms (`upload(..., { transform })`) go through the service
  too: the original is staged under the `_ablage-transform` group, the variant
  is fetched, and the staged copy is removed. This requires `sourceURL`.
  `transformImage()` itself still needs `sharp`.
- imgproxy receives the IPX modifiers translated to its options (`w`, `h`,
  `s`, `fit`, `enlarge`, `q`, `f`, `b`, `pos`, `blur`, `sharpen`, `rotate`);
  modifiers without an equivalent are dropped. A standalone IPX gets them as-is.
- imgproxy blocks loopback and private source addresses by default. If
  `sourceURL` points at one, set `IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES` /
  `IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES`. A standalone IPX needs the source
  host in `--domains`.

## Resumable uploads (tus)

Large or flaky-network uploads can use the [tus protocol](https://tus.io)
instead of a single multipart POST. Uploads are staged chunk-by-chunk into a
local directory (survives connection drops and page reloads), then *promoted*
into the regular file storage by one of your own server routes — which is
where you enforce auth and attach domain metadata.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['ablage'],
  ablage: {
    tus: {
      enabled: true,
      route: '/_ablage/tus',            // default
      stagingDir: '.data/tus',         // default
      maxSize: 500 * 1024 * 1024,      // optional, bytes
      expiration: 24 * 60 * 60 * 1000, // optional: purge stale staged uploads
    },
  },
})
```

Client side, the auto-imported `useTusUpload()` composable wraps
[`tus-js-client`](https://github.com/tus/tus-js-client) with reactive state:

```vue
<script setup lang="ts">
const tus = useTusUpload({
  metadata: (file) => ({ comment: 'from the web app' }), // extra tus metadata
  // cleanupOnPageHide: true,  // sendBeacon-delete staged uploads on close
})

function onSelect(e: Event) {
  tus.add(Array.from((e.target as HTMLInputElement).files ?? []))
}

async function save() {
  for (const item of tus.completed.value) {
    await $fetch('/api/documents/finalize', {
      method: 'POST',
      body: { tusId: item.tusId, name: item.file.name },
    })
  }
  tus.clear()
}
</script>
```

Each entry in `tus.items` tracks `progress`, `complete`, `tusId`, and `error`;
`tus.remove(name)` aborts and deletes a staged upload, `tus.cancel()` discards
everything. Interrupted uploads resume automatically (retry backoff, restart
on `online`, and — via the tus fingerprint — across page reloads).

Server side, promote a finished upload into the file storage:

```ts
// server/api/documents/finalize.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  const { id, meta } = await useTusStaging().promote(body.tusId, 'my-group', {
    meta: { type: 'document' },        // merged over tus filename/filetype
    // transform: { width: 1600 },     // optional sharp processing
  })

  return { id, meta }
})
```

`useTusStaging()` also exposes `info()`, `read()`, and `remove()` for staged
uploads. To protect or customize the endpoint itself (auth, upload hooks, a
different datastore), configure the underlying `@tus/server` from a Nitro
plugin — the server is created lazily on the first request:

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

Notes:

- The endpoint handles the full tus lifecycle (create/HEAD/PATCH/DELETE); a
  `POST <route>/cleanup` sub-route accepts `{ tusIds: string[] }` from
  `navigator.sendBeacon` for page-close cleanup (used by `cleanupOnPageHide`).
- Staging uses `@tus/file-store` on the local filesystem, independent of the
  configured storage provider — promotion works with any provider, including
  S3 and custom ones.

## S3 storage

For durable object storage (AWS S3, Cloudflare R2, MinIO, …) use the built-in
`createS3Provider`. It stores each file as a data object plus a JSON metadata
sidecar, and — unlike unstorage's generic `s3` driver — `list()`/`findByMeta()`
use real S3 prefix listing with continuation pagination, so a group stays
correctly scoped even inside a large or shared bucket.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['ablage'],
  ablage: { provider: 'custom' },
})
```

```ts
// server/plugins/file-provider.ts
export default defineNitroPlugin(() => {
  const { s3 } = useRuntimeConfig()
  setFileStorageProvider(createS3Provider({
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    endpoint: s3.endpoint,   // e.g. https://<acct>.r2.cloudflarestorage.com
    region: s3.region,       // R2: 'auto'
    bucket: s3.bucket,
    // prefix: 'media/',      // optional: namespace within a shared bucket
  }))
})
```

> `createS3Provider` requires the optional [`aws4fetch`](https://github.com/mhart/aws4fetch) peer dependency (`npm i aws4fetch`). Pass a custom `client` to use a different transport or to unit-test without network.

## Drizzle (metadata in your database)

`createDrizzleProvider` keeps file metadata in a table of your own
[Drizzle](https://orm.drizzle.team) database and the bytes in a blob store —
S3/R2 via `createS3Client()`, or any mounted Nitro storage. It uses only
Drizzle's core query builder, so it works with every dialect and driver on
Drizzle 0.36+ and v1.

```ts
// server/db/schema.ts
import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at'), // optional
  updatedAt: timestamp('updated_at'), // optional
}, t => [index('files_group_id_idx').on(t.groupId)])
```

```ts
// server/plugins/file-provider.ts  (with `ablage: { provider: 'custom' }`)
import { db } from '../utils/db'
import { files } from '../db/schema'

export default defineNitroPlugin(() => {
  const { s3 } = useRuntimeConfig()
  setFileStorageProvider(createDrizzleProvider({
    db,
    table: files,
    blobs: createS3Client({
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      endpoint: s3.endpoint,
      bucket: s3.bucket,
    }),
    // or keep bytes on disk in the module's fs storage: blobs: 'documents'  (= `ablage.storageName`)
    // columns: { id: 'id', groupId: 'groupId', metadata: 'metadata', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }))
})
```

- `columns` maps to the table's schema property names, so an existing table can be used. `createdAt`/`updatedAt` are filled in when the table has them.
- With a Postgres `jsonb` metadata column, `findByMeta()` (`@>`) and `update()` (`||` merge) run in the database — add a GIN index on `metadata` for large tables. Other column types and dialects filter and merge in JS.
- Bytes are stored at `<groupId>/data/<id>`, the same layout as the S3 and unstorage providers, so moving metadata into a database keeps existing files readable.
- Requires the optional `drizzle-orm` peer dependency.

### Migrating from the unstorage provider

Point `blobs` at the existing mount (`blobs: 'documents'`) so the bytes stay
where they are, then copy the metadata sidecars into the table once —
`importUnstorageMetadata` keeps ids and timestamps and skips rows that already
exist, so re-running it is safe:

```ts
// server/tasks/ablage/import.ts  (run with `nuxi task run ablage:import`)
import { db } from '../../utils/db'
import { files } from '../../db/schema'

export default defineTask({
  meta: { description: 'Copy ablage metadata into the database' },
  async run() {
    const result = await importUnstorageMetadata({ from: 'documents', db, table: files })
    return { result } // { imported, skipped }
  },
})
```

## Custom Provider

For advanced use cases (other databases, external file sync), implement the `FileStorageProvider` interface and register it in a Nitro plugin:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['ablage'],
  ablage: {
    provider: 'custom',
  },
})
```

```ts
// server/plugins/file-provider.ts
export default defineNitroPlugin(() => {
  setFileStorageProvider({
    async create(groupId, data, meta) {
      // Store binary data (e.g. S3, unstorage)
      // Store metadata (e.g. Prisma, Drizzle)
      return { id: '...' }
    },
    async get(groupId, id) { /* ... */ },
    async getData(groupId, id) { /* ... */ },
    async getMeta(id) { /* ... */ },
    async list(groupId) { /* ... */ },
    async update(id, meta) { /* ... */ },
    async remove(groupId, id) { /* ... */ },
    async clear(groupId) { /* ... */ },
    async has(groupId, id) { /* ... */ },
    async findByMeta(filter) { /* ... */ },

    // Optional: external file sync
    external: {
      async sync(groupId, id) { /* ... */ },
      async push(groupId, id, data, meta) { /* ... */ },
      async pull(groupId, externalRef) { /* ... */ },
    },
  })
})
```

### Provider interface

```ts
interface FileStorageProvider {
  create(groupId: string, data: Buffer | Uint8Array, meta?: FileMeta): Promise<{ id: string }>
  get(groupId: string, id: string): Promise<StoredFile | null>
  // Optional: metadata without the bytes. Used by sendStoredFile and the IPX
  // route to answer 304s without reading the file; falls back to get().
  head?(groupId: string, id: string): Promise<StoredFile | null>
  getData(groupId: string, id: string): Promise<Buffer | null>
  getMeta(id: string): Promise<FileMeta | null>
  list(groupId: string): Promise<StoredFile[]>
  update(id: string, meta: Partial<FileMeta>): Promise<void>
  remove(groupId: string, id: string): Promise<void>
  clear(groupId: string): Promise<void>
  has(groupId: string, id: string): Promise<boolean>
  findByMeta(filter: { key: string; value: unknown; groupId?: string }): Promise<StoredFile | null>
  external?: FileStorageExternalProvider
}
```

### Types

```ts
interface FileMeta {
  name: string
  mime: string
  type: string
  version: number
  username?: string
  comment?: string
  [key: string]: unknown  // extend with your own fields
}

interface StoredFile {
  id: string
  groupId: string
  data?: Buffer
  meta: FileMeta
  external?: ExternalRef
  createdAt?: Date
  updatedAt?: Date
}

interface ExternalRef {
  source: string       // e.g. 'jira', 'sharepoint'
  externalId: string
  externalUrl?: string
  cachedAt?: Date
}
```

## Contribution

<details>
  <summary>Local development</summary>

  ```bash
  # Install dependencies
  pnpm install

  # Generate type stubs
  pnpm run dev:prepare

  # Develop with the playground
  pnpm run dev

  # Run ESLint
  pnpm run lint

  # Run Vitest
  pnpm run test

  # Release new version
  pnpm run release
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
