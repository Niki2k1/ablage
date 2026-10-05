import {
  type H3Event,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
  createError,
} from 'h3';
import type { StoredFile } from '../../../runtime/types';
import { headStoredFile, useFileStorageProvider } from '../provider';

export type { StoredFile };

export interface SendStoredFileOptions {
  /**
   * `content-disposition` type. `'inline'` (the default) lets the browser
   * render the file in place; `'attachment'` forces a download.
   */
  disposition?: 'inline' | 'attachment';
  /** Override the download filename. Defaults to the stored `meta.name`. */
  filename?: string;
  /**
   * `cache-control` max-age in seconds. Default: one year — matching the IPX
   * route. Pass `0` to mark the response uncacheable.
   */
  maxAge?: number;
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, matching the IPX route.

/**
 * The mtime the IPX route also uses: prefer `updatedAt`, fall back to
 * `createdAt`. Truncated to whole seconds like HTTP dates, so an echoed
 * `if-modified-since` compares equal instead of looking older.
 */
function fileMtime(file: StoredFile): Date | undefined {
  const mtime = file.updatedAt ?? file.createdAt;
  return mtime ? new Date(Math.floor(mtime.getTime() / 1000) * 1000) : undefined;
}

/**
 * Build a weak validator from the file's mtime so revalidation can be answered
 * without reading the bytes back. Mirrors the IPX route, which keys its etag /
 * last-modified off the same mtime.
 */
function cacheValidators(file: StoredFile): {
  etag?: string;
  lastModified?: Date;
} {
  const mtime = fileMtime(file);
  if (!mtime) return {};
  return { etag: `W/"${mtime.getTime().toString(16)}"`, lastModified: mtime };
}

/** RFC 6266 `content-disposition` value with an ASCII fallback + UTF-8 form. */
function contentDisposition(type: string, name: string): string {
  // Strip anything outside printable ASCII (plus quote/backslash) for the
  // legacy `filename=`; the `filename*=` form carries the real UTF-8 name.
  const asciiName = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Stream a stored file back through an H3 event with the same HTTP revalidation
 * story as the IPX image route: `content-type` from `meta.mime`, a
 * `content-disposition` filename from `meta.name`, and
 * `cache-control` / `last-modified` / `etag` honoring `if-modified-since` /
 * `if-none-match` (304). Throws a 404 when the file does not exist.
 *
 * ```ts
 * // server/api/files/[groupId]/[id].get.ts
 * export default defineEventHandler((event) => {
 *   const { groupId, id } = getRouterParams(event)
 *   return sendStoredFile(event, groupId, id)
 * })
 * ```
 */
export async function sendStoredFile(
  event: H3Event,
  groupId: string,
  id: string,
  options: SendStoredFileOptions = {}
): Promise<Buffer | null> {
  const provider = useFileStorageProvider();

  // Metadata only, so a 304 never reads the bytes (with providers that
  // implement `head()`; otherwise `get()` already loaded them and are reused).
  const file = await headStoredFile(provider, groupId, id);
  if (!file) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' });
  }

  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const { etag, lastModified } = cacheValidators(file);

  setResponseHeader(
    event,
    'cache-control',
    maxAge > 0 ? `public, max-age=${maxAge}` : 'no-cache'
  );
  if (etag) setResponseHeader(event, 'etag', etag);
  if (lastModified)
    setResponseHeader(event, 'last-modified', lastModified.toUTCString());

  // Conditional request handling — answer 304 before touching the bytes.
  const ifNoneMatch = getRequestHeader(event, 'if-none-match');
  const ifModifiedSince = getRequestHeader(event, 'if-modified-since');
  // RFC 9110: if-none-match takes precedence; if-modified-since applies only
  // when it's absent.
  const notModified = ifNoneMatch
    ? !!etag && ifNoneMatch === etag
    : !!lastModified
      && !!ifModifiedSince
      && lastModified.getTime() <= Date.parse(ifModifiedSince);
  if (notModified) {
    setResponseStatus(event, 304);
    return null;
  }

  setResponseHeader(
    event,
    'content-type',
    file.meta.mime || 'application/octet-stream'
  );
  setResponseHeader(
    event,
    'content-disposition',
    contentDisposition(
      options.disposition ?? 'inline',
      options.filename ?? file.meta.name
    )
  );

  const data = file.data ?? (await provider.getData(groupId, id));
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' });
  }

  setResponseHeader(event, 'content-length', data.length);

  // HEAD requests get the full header set but no body.
  if (event.method === 'HEAD') return null;

  return data;
}
