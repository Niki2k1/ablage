import type { ByteRange, FileBody, FileObject, FileRef, PutBody } from '../../../runtime/types';

// Framework-free helpers shared by useFileStorage() and the providers.

const ID_RE = /^[\w.-]{1,128}$/;

/** Throw unless `id` is a safe file id (letters, digits, `.`, `_`, `-`). */
export function assertId(id: string): void {
  if (!ID_RE.test(id) || id === '.' || id === '..') {
    throw new TypeError(`[ablage] invalid file id "${id}" (allowed: letters, digits, ".", "_", "-"; max 128)`);
  }
}

/** Normalize a group: trim surrounding slashes (IPX hands them through with a leading one). */
export function normalizeGroup(group: string): string {
  const normalized = group.replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new TypeError('[ablage] file group must not be empty');
  return normalized;
}

export function normalizeRef(ref: FileRef): FileRef {
  assertId(ref.id);
  return { group: normalizeGroup(ref.group), id: ref.id };
}

/** SHA-256 of the bytes, base64url-encoded: the stored `etag`. */
export async function computeEtag(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Clamp a requested range to a file of `size` bytes. */
export function clampRange(size: number, range: ByteRange): { offset: number; length: number } {
  const offset = Math.min(Math.max(0, Math.floor(range.offset)), size);
  const max = size - offset;
  const length = range.length === undefined ? max : Math.min(Math.max(0, Math.floor(range.length)), max);
  return { offset, length };
}

export function bytesToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (data.length) controller.enqueue(data);
      controller.close();
    },
  });
}

/** A stream over `data`, or the clamped `range` of it. */
export function rangeStream(data: Uint8Array, range?: ByteRange): ReadableStream<Uint8Array> {
  if (!range) return bytesToStream(data);
  const { offset, length } = clampRange(data.length, range);
  return bytesToStream(data.subarray(offset, offset + length));
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Read any accepted upload body into memory. */
export async function bodyToBytes(body: PutBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return streamToBytes(body as ReadableStream<Uint8Array>);
}

/** Wrap a stream into a {@link FileBody}. */
export function toFileBody(
  object: FileObject,
  body: ReadableStream<Uint8Array>,
  range?: { offset: number; length: number },
): FileBody {
  let consumed = false;
  return {
    ...object,
    body,
    range,
    async bytes() {
      if (consumed) throw new Error('[ablage] file body was already read');
      consumed = true;
      return streamToBytes(body);
    },
  };
}

/** JSON form of a FileObject (dates as ISO strings), for sidecar storage. */
export type SerializedFileObject = Omit<FileObject, 'uploadedAt' | 'updatedAt'> & {
  uploadedAt: string;
  updatedAt: string;
};

export function serializeObject(object: FileObject): SerializedFileObject {
  return { ...object, uploadedAt: object.uploadedAt.toISOString(), updatedAt: object.updatedAt.toISOString() };
}

export function deserializeObject(raw: SerializedFileObject): FileObject {
  return {
    ...raw,
    customMetadata: raw.customMetadata ?? {},
    uploadedAt: new Date(raw.uploadedAt),
    updatedAt: new Date(raw.updatedAt),
  };
}

/** Apply a metadata patch the way every provider should. */
export function applyPatch(object: FileObject, patch: import('../../../runtime/types').FileMetaPatch): FileObject {
  return {
    ...object,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.contentType !== undefined ? { contentType: patch.contentType } : {}),
    ...(patch.cacheControl !== undefined ? { cacheControl: patch.cacheControl } : {}),
    customMetadata: { ...object.customMetadata, ...patch.customMetadata },
    updatedAt: new Date(),
  };
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
};

/**
 * An expected HTTP error (404, 409, …). Carries h3's error marker, which both
 * h3 v1 and Nuxt's `isNuxtError()` check, so it's rendered with its status and
 * not logged as an unhandled crash — without importing h3.
 */
export class HttpError extends Error {
  static readonly __h3_error__ = true;
  readonly status: number;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly fatal = false;
  readonly unhandled = false;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.statusCode = status;
    this.statusMessage = STATUS_TEXT[status] ?? 'Error';
  }

  toJSON() {
    return { message: this.message, statusCode: this.statusCode, statusMessage: this.statusMessage };
  }
}

export function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}
