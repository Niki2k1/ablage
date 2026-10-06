import type { ByteRange, FileRef } from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import { httpError, normalizeRef } from './objects';

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
  /** A full `cache-control` value; takes precedence over `maxAge`. */
  cacheControl?: string;
}

/** The parts of a request the response depends on. */
export interface RequestLike {
  method: string;
  headers: Headers;
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, matching the image route.

/** RFC 6266 `content-disposition` value with an ASCII fallback + UTF-8 form. */
export function contentDisposition(type: string, name: string): string {
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
 * Build the HTTP response for a stored file. Framework-free: takes the
 * request's method and headers, returns a standard `Response`.
 *
 * - The body is streamed; `content-type`, `content-length`,
 *   `content-disposition`, `cache-control`, `etag` and `last-modified` come
 *   from the stored metadata.
 * - Answers `if-none-match` / `if-modified-since` with 304, and HEAD
 *   requests with headers only, without reading the bytes.
 * - Serves single `Range` requests (206, or 416 when unsatisfiable), honoring `if-range`.
 * - Throws a 404 error when the file doesn't exist.
 */
export async function createFileResponse(
  request: RequestLike,
  ref: FileRef,
  options: SendStoredFileOptions = {},
): Promise<Response> {
  const provider = useFileStorageProvider();
  const normalized = normalizeRef(ref);
  const file = await provider.head(normalized);
  if (!file) throw httpError(404, 'File not found');

  const lastModified = httpDate(file.updatedAt);
  const headers = new Headers({
    'cache-control': options.cacheControl
      ?? (options.maxAge !== undefined
        ? (options.maxAge > 0 ? `public, max-age=${options.maxAge}` : 'no-cache')
        : file.cacheControl ?? `public, max-age=${DEFAULT_MAX_AGE}`),
    'etag': `"${file.etag}"`,
    'last-modified': lastModified.toUTCString(),
    'accept-ranges': 'bytes',
  });

  // RFC 9110: if-none-match takes precedence; if-modified-since applies only when it's absent.
  const ifNoneMatch = request.headers.get('if-none-match');
  const ifModifiedSince = request.headers.get('if-modified-since');
  const notModified = ifNoneMatch
    ? etagMatches(ifNoneMatch, file.etag)
    : !!ifModifiedSince && lastModified.getTime() <= Date.parse(ifModifiedSince);
  if (notModified) return new Response(null, { status: 304, headers });

  headers.set('content-type', file.contentType);
  headers.set('content-disposition', contentDisposition(options.disposition ?? 'inline', options.filename ?? file.name ?? file.id));

  // A range applies only while the client's copy (if-range) is still current.
  const rangeHeader = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const rangeValid = !ifRange
    || (ifRange.startsWith('"') ? ifRange === `"${file.etag}"` : Date.parse(ifRange) >= lastModified.getTime());
  const range = rangeHeader && rangeValid ? parseRange(rangeHeader, file.size) : null;

  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const status = range ? 206 : 200;
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  headers.set('content-length', String(range ? range.length : file.size));

  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const body = await provider.read(normalized, range ?? undefined);
  if (!body) throw httpError(404, 'File not found');
  return new Response(body, { status, headers });
}

/**
 * The request behind an event: a `nuxt/server` event's web `Request`, or an
 * h3 v1 event's Node request.
 */
function requestOf(event: {
  req?: unknown;
  method?: string;
  node?: { req: { method?: string; headers: Record<string, string | string[] | undefined> } };
}): RequestLike {
  if (event.req instanceof Request) return event.req;
  const node = event.node?.req;
  if (!node) throw new TypeError('[ablage] sendStoredFile: unsupported event');
  const headers = new Headers();
  for (const [name, value] of Object.entries(node.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return { method: event.method ?? node.method ?? 'GET', headers };
}

/**
 * Serve a stored file from a route (see {@link createFileResponse}). Works with
 * `nuxt/server` and h3 event handlers; return its result from the handler.
 * Use a method-agnostic route file (`[id].ts`, not `[id].get.ts`) so HEAD
 * requests reach it.
 *
 * ```ts
 * // server/api/files/[group]/[id].ts
 * export default defineEventHandler((event) => {
 *   const { group, id } = getRouterParams(event)
 *   return sendStoredFile(event, { group, id })
 * })
 * ```
 */
export function sendStoredFile(
  event: Parameters<typeof requestOf>[0],
  ref: FileRef,
  options: SendStoredFileOptions = {},
): Promise<Response> {
  return createFileResponse(requestOf(event), ref, options);
}
