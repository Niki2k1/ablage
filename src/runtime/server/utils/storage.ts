import type {
  ImageTransformOptions,
  CustomMetadata,
  FileBody,
  FileMetaPatch,
  FileObject,
  FileRef,
  GetOptions,
  ListOptions,
  ListResult,
  PutBody,
  PutOptions,
} from '../../../runtime/types';
import { deriveSecret } from 'nuxt/server';
// @ts-expect-error virtual module injected by the module
import { fileRoute, imageRouteEnabled, ipxRoute } from '#ablage-image';
import { useFileStorageProvider } from '../provider';
import { stringifyModifiers, transformToModifiers, type ImageModifiers } from './image-service';
import { refPath, signFileClaims } from './signing';
import { contentDisposition } from './send';
import { transformImage } from './image';
import { transformWithService, useImageService } from './image-service-runtime';
import {
  assertId,
  bodyToBytes,
  clampRange,
  computeEtag,
  httpError,
  normalizeGroup,
  normalizeRef,
  toFileBody,
} from './objects';

export type {
  CustomMetadata,
  FileBody,
  FileMetaPatch,
  FileObject,
  FileRef,
  GetOptions,
  ListOptions,
  ListResult,
  PutBody,
  PutOptions,
};

const DEFAULT_LIST_LIMIT = 1000;

/** `deriveSecret()` purpose for signed file URLs; the file route verifies with the same key. */
export const SIGNING_PURPOSE = 'ablage:signed-url';

function isFileObject(ref: FileRef): ref is FileObject {
  return 'contentType' in ref && 'etag' in ref;
}

const TRANSFORM_KEYS = new Set(['width', 'height', 'fit', 'withoutEnlargement', 'format', 'quality', 'animated', 'background']);
function isTransformOptions(value: object): value is ImageTransformOptions {
  return Object.keys(value).some((key) => TRANSFORM_KEYS.has(key));
}

/**
 * Server-side file storage API, backed by the registered provider.
 *
 * ```ts
 * const storage = useFileStorage()
 * const file = await storage.put('avatars', data, { contentType: 'image/png', customMetadata: { userId } })
 * const head = await storage.head(file)        // metadata only
 * const body = await storage.get(file)         // + body stream / bytes()
 * ```
 */
export function useFileStorage() {
  const provider = useFileStorageProvider();

  /** A file's metadata without reading its bytes, or `null`. */
  async function head<M extends CustomMetadata = CustomMetadata>(ref: FileRef): Promise<FileObject<M> | null> {
    return (await provider.head(normalizeRef(ref))) as FileObject<M> | null;
  }

  /** A file with its body (optionally a byte range), or `null`. */
  async function get<M extends CustomMetadata = CustomMetadata>(
    ref: FileRef,
    options: GetOptions = {},
  ): Promise<FileBody<M> | null> {
    const normalized = normalizeRef(ref);
    const [object, body] = await Promise.all([
      provider.head(normalized),
      provider.read(normalized, options.range),
    ]);
    if (!object || !body) {
      await body?.cancel();
      return null;
    }
    const range = options.range ? clampRange(object.size, options.range) : undefined;
    return toFileBody(object, body, range) as FileBody<M>;
  }

  /** Store a file in `group` and return its metadata. */
  async function put<M extends CustomMetadata = CustomMetadata>(
    group: string,
    body: PutBody,
    options: PutOptions<M> = {},
  ): Promise<FileObject<M>> {
    const ref = { group: normalizeGroup(group), id: options.id ?? crypto.randomUUID() };
    assertId(ref.id);

    if (options.id !== undefined && (!options.overwrite || options.ifMatch !== undefined)) {
      const existing = await provider.head(ref);
      if (options.ifMatch !== undefined) {
        if (existing?.etag !== options.ifMatch) {
          throw httpError(412, `File "${ref.group}/${ref.id}" does not match the expected etag`);
        }
      }
      else if (existing) {
        throw httpError(409, `File "${ref.group}/${ref.id}" already exists (pass overwrite: true to replace it)`);
      }
    }

    let data = await bodyToBytes(body);
    let contentType = options.contentType;
    let width: number | undefined;
    let height: number | undefined;

    if (options.transform) {
      const service = useImageService();
      const result = service
        ? await transformWithService(service, data, options.transform, contentType)
        : await transformImage(data, options.transform);
      data = result.data;
      contentType = result.mime;
      width = result.width;
      height = result.height;
    }

    const now = new Date();
    const object: FileObject<M> = {
      ...ref,
      size: data.length,
      contentType: contentType || 'application/octet-stream',
      etag: await computeEtag(data),
      uploadedAt: now,
      updatedAt: now,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      customMetadata: options.customMetadata ?? ({} as M),
    };
    await provider.write(object, data);
    return object;
  }

  /** Change a file's metadata; `customMetadata` is merged shallowly. Throws 404 if missing. */
  async function updateMeta<M extends CustomMetadata = CustomMetadata>(
    ref: FileRef,
    patch: FileMetaPatch,
  ): Promise<FileObject<M>> {
    const normalized = normalizeRef(ref);
    const updated = await provider.updateMeta(normalized, patch);
    if (!updated) {
      throw httpError(404, `File "${normalized.group}/${normalized.id}" not found`);
    }
    return updated as FileObject<M>;
  }

  /** Delete one or more files; missing files are ignored. */
  async function remove(refs: FileRef | FileRef[]): Promise<void> {
    const list = (Array.isArray(refs) ? refs : [refs]).map(normalizeRef);
    if (list.length) await provider.remove(list);
  }

  /** A page of a group's files, ordered by id. */
  async function list<M extends CustomMetadata = CustomMetadata>(
    group: string,
    options: ListOptions = {},
  ): Promise<ListResult<M>> {
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIST_LIMIT));
    return (await provider.list(normalizeGroup(group), { ...options, limit })) as ListResult<M>;
  }

  /** Every file of a group, fetched page by page. */
  async function* listAll<M extends CustomMetadata = CustomMetadata>(
    group: string,
    options: Omit<ListOptions, 'cursor'> = {},
  ): AsyncGenerator<FileObject<M>> {
    let cursor: string | undefined;
    do {
      const page = await list<M>(group, { ...options, cursor });
      yield* page.objects;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  /** Delete every file in a group. */
  async function clear(group: string): Promise<void> {
    for (;;) {
      const page = await list(group, { limit: DEFAULT_LIST_LIMIT });
      if (!page.objects.length) return;
      await provider.remove(page.objects.map(({ group, id }) => ({ group, id })));
      if (!page.hasMore) return;
    }
  }

  /**
   * The first file whose `customMetadata[key] === value`, optionally within a
   * group. Throws when the provider doesn't support metadata lookups.
   */
  async function findByMeta<M extends CustomMetadata = CustomMetadata>(
    key: string,
    value: unknown,
    group?: string,
  ): Promise<FileObject<M> | null> {
    if (!provider.findByMeta) {
      throw new Error('[ablage] the configured storage provider does not support findByMeta()');
    }
    return (await provider.findByMeta({ key, value, group: group && normalizeGroup(group) })) as FileObject<M> | null;
  }

  /**
   * Path of a file on the image route: `/_ablage/image/<modifiers>/<group>/<id>`.
   * Without `transform` it serves the original. The route is public, like
   * `<NuxtImg provider="ablage">`; use {@link signedUrl} for private files.
   */
  function url(ref: FileRef, options: { transform?: ImageTransformOptions | ImageModifiers } = {}): string {
    if (!imageRouteEnabled) {
      throw new Error('[ablage] url() needs the image route; enable `ablage.image` (with @nuxt/image, `enabled: \'force\'`, or an image service)');
    }
    const normalized = normalizeRef(ref);
    const { transform } = options;
    const modifiers = !transform
      ? {}
      : isTransformOptions(transform) ? transformToModifiers(transform) : transform;
    return `${ipxRoute}/${stringifyModifiers(modifiers)}/${refPath(normalized)}`;
  }

  /**
   * A time-limited link to a file, served by the module's file route
   * (`/_ablage/file/...`) without any route of your own. Signed with a key
   * derived from Nuxt's `appSecret` (set `NUXT_APP_SECRET`, ≥ 32 characters).
   *
   * When the provider can presign reads (S3 with `publicEndpoint`), the link
   * points at the store instead, so the bytes never pass through the app.
   * Pass the `FileObject` rather than a bare ref to skip a metadata lookup.
   */
  async function signedUrl(
    ref: FileRef,
    options: { expiresIn?: number; download?: boolean } = {},
  ): Promise<string> {
    const normalized = normalizeRef(ref);
    const expiresIn = Math.max(1, Math.floor(options.expiresIn ?? 3600));
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const download = !!options.download;

    if (provider.presignRead) {
      const object = isFileObject(ref) ? ref : await provider.head(normalized);
      // A missing file falls through to a route link, which 404s like on other providers.
      if (object) {
        return provider.presignRead(normalized, {
          expiresIn,
          responseHeaders: {
            'content-type': object.contentType,
            'content-disposition': contentDisposition(download ? 'attachment' : 'inline', object.name ?? object.id),
            'cache-control': `private, max-age=${expiresIn}`,
          },
        });
      }
    }

    const sig = await signFileClaims(await deriveSecret(SIGNING_PURPOSE), { ...normalized, expires, download });
    const query = new URLSearchParams({ expires: String(expires), sig });
    if (download) query.set('download', '1');
    return `${fileRoute}/${refPath(normalized)}?${query}`;
  }

  return { head, get, put, updateMeta, remove, list, listAll, clear, findByMeta, url, signedUrl };
}
