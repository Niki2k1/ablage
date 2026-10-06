import {
  type H3Event,
  createError,
  getRequestHeader,
  readMultipartFormData,
} from 'h3';

/** A file read from a `multipart/form-data` request. */
export interface UploadedFile {
  /** The file's bytes. */
  data: Buffer;
  /** The client-supplied filename. */
  name: string;
  /** MIME type as sent by the client, `application/octet-stream` when missing. */
  type: string;
  /** Size in bytes. */
  size: number;
  /** The request's non-file form fields, e.g. `{ group: 'models' }`. */
  fields: Record<string, string>;
}

export interface ReadUploadedFileOptions {
  /**
   * Accepted types, using the syntax of the HTML `accept` attribute plus a
   * shorthand for families: an exact MIME type (`'image/png'`), a family
   * (`'image'` or `'image/*'`), or an extension (`'.stl'`). Any match is
   * enough. Default: anything.
   */
  types?: string[];
  /** Max size per file: bytes, or a string like `'500KB'` / `'2MB'` / `'1GB'` (1024-based). */
  maxSize?: number | string;
  /** Form field holding the file(s). Default: `'file'`. */
  field?: string;
}

export interface ReadUploadedFilesOptions extends ReadUploadedFileOptions {
  /** Max number of files. Default: unlimited. */
  max?: number;
}

const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Parse `'2MB'`-style sizes (1024-based); numbers are bytes. */
export function parseSize(size: number | string): number {
  if (typeof size === 'number') return size;
  const match = size.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/);
  if (!match) throw new Error(`[ablage] invalid size "${size}" (use e.g. 500KB, 2MB, 1GB)`);
  return Math.floor(Number(match[1]) * UNITS[match[2]!]!);
}

function formatSize(bytes: number): string {
  for (const unit of ['GB', 'MB', 'KB'] as const) {
    if (bytes >= UNITS[unit]! && bytes % UNITS[unit]! === 0) return `${bytes / UNITS[unit]!} ${unit}`;
  }
  return bytes >= UNITS.MB! ? `${(bytes / UNITS.MB!).toFixed(1)} MB` : `${bytes} B`;
}

/** Whether a file matches one of the accepted `types` (see {@link ReadUploadedFileOptions.types}). */
export function matchesType(file: { name: string; type: string }, types: string[]): boolean {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return types.some((raw) => {
    const type = raw.trim().toLowerCase();
    if (type.startsWith('.')) return name.endsWith(type);
    if (type.endsWith('/*')) return mime.startsWith(type.slice(0, -1));
    if (!type.includes('/')) return mime.startsWith(`${type}/`);
    return mime === type;
  });
}

// Generous per-part allowance for multipart boundaries and headers, so the
// Content-Length precheck never rejects a request that fits the limit.
const MULTIPART_OVERHEAD = 64 * 1024;

async function readFiles(event: H3Event, options: ReadUploadedFilesOptions): Promise<UploadedFile[]> {
  const field = options.field ?? 'file';
  const maxSize = options.maxSize === undefined ? undefined : parseSize(options.maxSize);

  // Reject obviously oversized requests before buffering the body.
  if (maxSize !== undefined && options.max !== undefined) {
    const length = Number(getRequestHeader(event, 'content-length'));
    if (length > (maxSize + MULTIPART_OVERHEAD) * options.max) {
      throw createError({ statusCode: 413, statusMessage: 'File too large', message: `File too large (max ${formatSize(maxSize)})` });
    }
  }

  const parts = (await readMultipartFormData(event)) ?? [];
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.name && part.filename === undefined) fields[part.name] = part.data.toString('utf8');
  }

  const files = parts
    .filter((part) => part.name === field && part.filename)
    .map((part): UploadedFile => ({
      data: part.data,
      name: part.filename!,
      type: part.type || 'application/octet-stream',
      size: part.data.length,
      fields,
    }));

  if (!files.length) {
    throw createError({ statusCode: 400, statusMessage: 'No file provided', message: `No file provided (expected form field "${field}")` });
  }
  if (options.max !== undefined && files.length > options.max) {
    throw createError({ statusCode: 400, statusMessage: 'Too many files', message: `Too many files (max ${options.max})` });
  }
  for (const file of files) {
    if (maxSize !== undefined && file.size > maxSize) {
      throw createError({
        statusCode: 413,
        statusMessage: 'File too large',
        message: `File "${file.name}" is too large (max ${formatSize(maxSize)})`,
      });
    }
    if (options.types && !matchesType(file, options.types)) {
      throw createError({
        statusCode: 415,
        statusMessage: 'Unsupported file type',
        message: `File type of "${file.name}" is not allowed (allowed: ${options.types.join(', ')})`,
      });
    }
  }
  return files;
}

/**
 * Read and validate a single uploaded file from a `multipart/form-data`
 * request. Throws an H3 error — 400 when no file is present, 413 when it
 * exceeds `maxSize`, 415 when its type isn't accepted — with a short
 * `statusMessage` and a `message` naming the file and the limit.
 *
 * ```ts
 * export default defineEventHandler(async (event) => {
 *   const file = await readUploadedFile(event, { types: ['image'], maxSize: '5MB' })
 *   const id = await useFileStorage().upload('avatars', file.data, {
 *     meta: { name: file.name, mime: file.type, type: 'image', version: 1 },
 *   })
 *   return { id }
 * })
 * ```
 */
export async function readUploadedFile(
  event: H3Event,
  options: ReadUploadedFileOptions = {},
): Promise<UploadedFile> {
  return (await readFiles(event, { ...options, max: 1 }))[0]!;
}

/** Like {@link readUploadedFile}, for several files in the same form field. */
export async function readUploadedFiles(
  event: H3Event,
  options: ReadUploadedFilesOptions = {},
): Promise<UploadedFile[]> {
  return readFiles(event, options);
}
