import {
  type H3Event,
  getRequestHeader,
  send,
  setResponseHeader,
  setResponseStatus,
  createError,
} from 'h3';
import type { ByteRange, FileRef } from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import { normalizeRef } from './objects';

export interface SendStoredFileOptions {
  /**
   * `content-disposition` type. `'inline'` (the default) lets the browser
   * render the file in place; `'attachment'` forces a download.
   */
  disposition?: 'inline' | 'attachment';
  /** Override the download filename. Defaults to the stored `name`, then the id. */
  filename?: string;
  /**
   * `cache-control` max-age in seconds; `0` marks the response uncacheable.
   * Default: the file's own `cacheControl`, else one year.
   */
  maxAge?: number;
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, matching the image route.

/** RFC 6266 `content-disposition` value with an ASCII fallback + UTF-8 form. */
function contentDisposition(type: string, name: string): string {
  // Strip anything outside printable ASCII (plus quote/backslash) for the
  // legacy `filename=`; the `filename*=` form carries the real UTF-8 name.
  const asciiName = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** HTTP dates have second precision; truncate so an echoed date compares equal. */
function httpDate(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/** Whether an `if-none-match` header matches the `etag` (weak comparison, RFC 9110). */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${etag}"`);
}

/** Parse a single `bytes=` range; `null` ignores the header, `'unsatisfiable'` means 416. */
function parseRange(header: string, size: number): Required<ByteRange> | null | 'unsatisfiable' {
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  // Malformed, or several ranges: serve the whole file.
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    // Suffix range: the last N bytes.
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { offset: size - length, length } : 'unsatisfiable';
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

/**
 * Send a stored file through an H3 event. The body is streamed;
 * `content-type`, `content-length`, `content-disposition`, `cache-control`,
 * `etag` and `last-modified` come from its metadata.
 *
 * - Answers `if-none-match` / `if-modified-since` with 304 without reading the bytes.
 * - Serves single `Range` requests (206, or 416 when unsatisfiable), honoring `if-range`.
 * - HEAD requests get the headers without the bytes being read.
 * - Throws a 404 when the file doesn't exist.
 *
 * ```ts
 * // server/api/files/[group]/[id].get.ts
 * export default defineEventHandler((event) => {
 *   const { group, id } = getRouterParams(event)
 *   return sendStoredFile(event, { group, id })
 * })
 * ```
 */
export async function sendStoredFile(
  event: H3Event,
  ref: FileRef,
  options: SendStoredFileOptions = {}
): Promise<ReadableStream<Uint8Array> | null> {
  const provider = useFileStorageProvider();
  const normalized = normalizeRef(ref);
  const file = await provider.head(normalized);
  if (!file) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' });
  }

  const lastModified = httpDate(file.updatedAt);
  const cacheControl = options.maxAge !== undefined
    ? (options.maxAge > 0 ? `public, max-age=${options.maxAge}` : 'no-cache')
    : file.cacheControl ?? `public, max-age=${DEFAULT_MAX_AGE}`;

  setResponseHeader(event, 'cache-control', cacheControl);
  setResponseHeader(event, 'etag', `"${file.etag}"`);
  setResponseHeader(event, 'last-modified', lastModified.toUTCString());
  setResponseHeader(event, 'accept-ranges', 'bytes');

  // RFC 9110: if-none-match takes precedence; if-modified-since applies only when it's absent.
  const ifNoneMatch = getRequestHeader(event, 'if-none-match');
  const ifModifiedSince = getRequestHeader(event, 'if-modified-since');
  const notModified = ifNoneMatch
    ? etagMatches(ifNoneMatch, file.etag)
    : !!ifModifiedSince && lastModified.getTime() <= Date.parse(ifModifiedSince);
  if (notModified) {
    setResponseStatus(event, 304);
    return null;
  }

  setResponseHeader(event, 'content-type', file.contentType);
  setResponseHeader(
    event,
    'content-disposition',
    contentDisposition(options.disposition ?? 'inline', options.filename ?? file.name ?? file.id)
  );

  // A range applies only while the client's copy (if-range) is still current.
  const rangeHeader = getRequestHeader(event, 'range');
  const ifRange = getRequestHeader(event, 'if-range');
  const rangeValid = !ifRange
    || (ifRange.startsWith('"') ? ifRange === `"${file.etag}"` : Date.parse(ifRange) >= lastModified.getTime());
  const range = rangeHeader && rangeValid ? parseRange(rangeHeader, file.size) : null;

  if (range === 'unsatisfiable') {
    setResponseHeader(event, 'content-range', `bytes */${file.size}`);
    throw createError({ statusCode: 416, statusMessage: 'Range Not Satisfiable' });
  }
  if (range) {
    setResponseStatus(event, 206);
    setResponseHeader(event, 'content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  }
  setResponseHeader(event, 'content-length', range ? range.length : file.size);

  // HEAD: headers only. End explicitly, as returning null would turn it into a 204.
  if (event.method === 'HEAD') {
    await send(event, '');
    return null;
  }

  const body = await provider.read(normalized, range ?? undefined);
  if (!body) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' });
  }
  return body;
}
