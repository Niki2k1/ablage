import { createError } from 'h3';
import type {
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
import { useFileStorageProvider } from '../provider';
import { transformImage } from './image';
import { transformWithService, useImageService } from './image-service-runtime';
import {
  assertId,
  bodyToBytes,
  clampRange,
  computeEtag,
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
          throw createError({ statusCode: 412, message: `File "${ref.group}/${ref.id}" does not match the expected etag` });
        }
      }
      else if (existing) {
        throw createError({ statusCode: 409, message: `File "${ref.group}/${ref.id}" already exists (pass overwrite: true to replace it)` });
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
      throw createError({ statusCode: 404, message: `File "${normalized.group}/${normalized.id}" not found` });
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

  return { head, get, put, updateMeta, remove, list, listAll, clear, findByMeta };
}
