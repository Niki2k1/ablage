# Migrating from nuxt-filer 0.0.x to ablage 0.1

ablage 0.1 is nuxt-filer under a new name, with a redesigned storage API
([RFC #21](https://github.com/Niki2k1/ablage/issues/21)). Stored bytes keep their
locations; stored metadata is converted once with a helper (step 5).

## 1. Requirements

- Nuxt ≥ 4.6 and Node `^22.22.3 || ^24.15.0 || >=26`.
- For `signedUrl()`: Nuxt's `appSecret` (`NUXT_APP_SECRET`, ≥ 32 characters).

## 2. Package, config and routes

```bash
npm remove nuxt-filer && npm i ablage
```

| nuxt-filer | ablage |
|---|---|
| `modules: ['nuxt-filer']` | `modules: ['ablage']` |
| config key `filer: {}` | `ablage: {}` (same options) |
| image route `/_filer-ipx/...` | `/_ablage/image/...` |
| tus route `/_filer-tus` | `/_ablage/tus` |
| `<NuxtImg provider="filer">` | `<NuxtImg provider="ablage">` |
| `NUXT_FILER_IMAGE_*` env vars | `NUXT_ABLAGE_IMAGE_*` |
| types `FilerImageOptions`, `FilerTusOptions` | `AblageImageOptions`, `AblageTusOptions` |

If image URLs like `/_filer-ipx/...` are stored in your content or database, keep
the old path instead of rewriting them:

```ts
ablage: {
  image: { route: '/_filer-ipx', providerName: 'filer' },
  tus: { route: '/_filer-tus' },
},
```

The storage defaults (`storageName: 'documents'`, `storagePath: '.data/documents'`)
are unchanged, so existing files are found where they are.

## 3. API

Files are now addressed by a `FileRef` — `{ group, id }` — in every call, and
metadata is a `FileObject`: system fields (`size`, `contentType`, `etag`,
`uploadedAt`, `updatedAt`, `name`, `cacheControl`, `width`, `height`) plus your
own `customMetadata`.

| nuxt-filer | ablage |
|---|---|
| `upload(groupId, data, { meta })` → `id` | `put(group, data, { name, contentType, customMetadata })` → `FileObject` |
| `upload(..., { transform })` | `put(..., { transform })` — no longer mutates `meta` |
| `get(groupId, id)` → `{ data: Buffer, meta, … }` | `get({ group, id })` → `FileObject` + `body` stream + `bytes()` |
| `getData(groupId, id)` | `(await get(ref))?.bytes()` |
| `getMeta(id)` (searched every group) | `head({ group, id })` |
| `has(groupId, id)` | `!!(await head(ref))` |
| `list(groupId)` → `StoredFile[]` | `list(group, { limit, cursor, prefix })` → `{ objects, cursor, hasMore }`, or `listAll(group)` |
| `updateMeta(id, meta)` | `updateMeta({ group, id }, { name, contentType, cacheControl, customMetadata })` |
| `remove(groupId, id)` | `remove({ group, id })` or `remove([refs])` |
| `clear(groupId)` | `clear(group)` |
| `findByMeta(key, value, groupId)` | unchanged; now matches `customMetadata[key]` |
| `checkDuplicate(groupId, key, value)` | `!!(await findByMeta(key, value, group))` |
| `getLatestVersions` / `getNextVersionNumber` | removed — keep versions in `customMetadata` or your database |
| `external.sync/push/pull` | removed — sync from your own code |
| `sendStoredFile(event, groupId, id, options)` | `sendStoredFile(event, { group, id }, options)` |
| `useTusStaging().promote(tusId, groupId, { meta })` → `{ id, meta }` | `promote(tusId, group, { name, contentType, customMetadata, … })` → `FileObject` |
| types `FileMeta`, `StoredFile`, `ExternalRef` | `FileObject`, `FileRef`, `CustomMetadata`, … |

Field mapping for metadata: `meta.name` → `name`, `meta.mime` → `contentType`,
`meta.width`/`height` → `width`/`height`, everything else (including `type` and
`version`) → `customMetadata`.

Example:

```ts
// nuxt-filer
const id = await storage.upload('avatars', data, {
  meta: { name: 'me.png', mime: 'image/png', type: 'avatar', version: 1, userId },
})
const meta = await storage.getMeta(id)
setResponseHeader(event, 'content-type', meta.mime)
return await storage.getData('avatars', id)

// ablage
const file = await storage.put('avatars', data, {
  name: 'me.png', contentType: 'image/png', customMetadata: { userId },
})
return sendStoredFile(event, file)
```

**Serving routes:** `sendStoredFile` now returns a streamed `Response`. Name the
route file without a method suffix (`[id].ts`, not `[id].get.ts`) so HEAD
requests reach it.

**New:** `put({ id, overwrite, ifMatch })`, ranged `get()`, `url()` and
`signedUrl()`, `readUploadedFile()`, `generateThumbnail()`. See the
[README](./README.md).

## 4. Custom providers

The provider interface changed: `create/get/getData/getMeta/update/has/clear/external`
became `head/read/write/updateMeta/remove/list` plus an optional `findByMeta`.
`useFileStorage()` now generates ids, computes size and `etag`, sets timestamps
and checks `overwrite` / `ifMatch`, so providers only persist. See
[Your own provider](./README.md#your-own-provider).

## 5. Convert stored metadata

The built-in providers ignore metadata in the 0.0.x format, so files are invisible
until it's converted. Each helper rewrites metadata in place (`size` and `etag`
computed from the bytes, fields mapped as above), creates metadata for files that
had none, never touches the bytes, skips files already converted, and is safe to
re-run. They return `{ migrated, skipped, orphaned }` (`orphaned`: metadata whose
bytes are missing).

Run the one for your provider right after deploying, e.g. as a
[Nitro task](https://nitro.build/guide/tasks)
(`nitro: { experimental: { tasks: true } }`):

```ts
// server/tasks/ablage/migrate.ts — run with `npx nuxi task run ablage:migrate`
export default defineTask({
  meta: { description: 'Convert nuxt-filer 0.0.x metadata' },
  async run() {
    // default unstorage provider:
    const result = await migrateUnstorageMetadata({ from: 'documents' })

    // S3 provider (same options as createS3Provider):
    // const result = await migrateS3Metadata({ accessKeyId, secretAccessKey, endpoint, bucket, prefix })

    // Drizzle provider (blobs: the same blob store the provider uses):
    // const result = await migrateDrizzleMetadata({ db, table: files, blobs: 'documents' })

    return { result }
  },
})
```

For small stores, calling it from a Nitro plugin at startup works too; it only
reads metadata for files already converted.

**Drizzle:** ids are now unique per group. Change the table's primary key from
`id` to `(groupId, id)` with your usual schema migration (e.g. `drizzle-kit
generate`).

**unstorage → Drizzle:** `importUnstorageMetadata({ from, db, table })` copies
0.0.x (or 0.1) sidecars into a Drizzle table, converting them on the way.
