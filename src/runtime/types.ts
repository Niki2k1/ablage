/** Custom, app-defined metadata stored with a file. Values must be JSON-serializable. */
export type CustomMetadata = Record<string, unknown>;

/** Addresses a stored file. */
export interface FileRef {
  /** The group the file belongs to, e.g. `'avatars'` or `'project:42'`. */
  group: string;
  /** The file id: server-generated, or chosen via `put({ id })`. */
  id: string;
}

/** A stored file's metadata: system fields plus your {@link CustomMetadata}. */
export interface FileObject<M extends CustomMetadata = CustomMetadata> extends FileRef {
  /** Size in bytes. */
  size: number;
  /** MIME type, e.g. `image/webp`. Default: `application/octet-stream`. */
  contentType: string;
  /**
   * Changes only when the bytes change. A SHA-256 (base64url) for files
   * written by `put()`; the store's own ETag for direct uploads.
   */
  etag: string;
  /** When these bytes were written. */
  uploadedAt: Date;
  /** When the bytes or metadata last changed. */
  updatedAt: Date;
  /** Original filename, used e.g. for `content-disposition`. */
  name?: string;
  /** `cache-control` for serving this file; overrides the route default. */
  cacheControl?: string;
  /** Image dimensions, when known (set by upload-time transforms). */
  width?: number;
  height?: number;
  customMetadata: M;
}

/** A byte range; `length` defaults to the rest of the file. */
export interface ByteRange {
  offset: number;
  length?: number;
}

/** A file with a readable body, as returned by `get()`. */
export interface FileBody<M extends CustomMetadata = CustomMetadata> extends FileObject<M> {
  /** The file's bytes (or the requested range), as a stream. Read it at most once. */
  body: ReadableStream<Uint8Array>;
  /** Read the whole body into memory. */
  bytes(): Promise<Uint8Array>;
  /** The range actually returned, when one was requested (clamped to the file size). */
  range?: { offset: number; length: number };
}

/** Accepted upload bodies. */
export type PutBody = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface PutOptions<M extends CustomMetadata = CustomMetadata> {
  /**
   * Store at this id instead of a generated UUID. Ids may contain letters,
   * digits, `.`, `_` and `-` (max 128 characters).
   */
  id?: string;
  /** Replace an existing file at `id`. Default: `false` (a 409 error if it exists). */
  overwrite?: boolean;
  /** Only replace the file if its current `etag` matches (a 412 error otherwise). Implies `overwrite`. */
  ifMatch?: string;
  contentType?: string;
  name?: string;
  cacheControl?: string;
  customMetadata?: M;
  /** Process an image before storing it (via the image service, or locally with sharp). */
  transform?: ImageTransformOptions;
}

export interface GetOptions {
  range?: ByteRange;
}

export interface ListOptions {
  /** Max files per page. Default: 1000. */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
  /** Only files whose id starts with this prefix. */
  prefix?: string;
}

export interface ListResult<M extends CustomMetadata = CustomMetadata> {
  objects: FileObject<M>[];
  /** Pass to the next `list()` call; set when `hasMore`. */
  cursor?: string;
  hasMore: boolean;
}

/**
 * Metadata changes for `updateMeta()`. `customMetadata` is merged
 * shallowly into the existing object; the other fields are replaced.
 */
export interface FileMetaPatch {
  name?: string;
  contentType?: string;
  cacheControl?: string;
  customMetadata?: CustomMetadata;
}

/** Output image format for {@link transformImage}. */
export type ImageFormat = 'webp' | 'png' | 'jpeg' | 'avif' | 'gif';

/**
 * Options for upload-time image processing, backed by the optional `sharp`
 * peer dependency. Passed via `useFileStorage().put(.., { transform })` or
 * to the standalone `transformImage()` util.
 */
export interface ImageTransformOptions {
  /** Target width in px. Combined with `fit` to bound the image. */
  width?: number;
  /** Target height in px. Combined with `fit` to bound the image. */
  height?: number;
  /**
   * How the image is resized to fit `width`/`height`. Mirrors sharp's `fit`.
   * Default: `'inside'` (preserve aspect ratio, fit within the box).
   */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Never scale the image up beyond its original size. Default: `true`. */
  withoutEnlargement?: boolean;
  /** Output format. Default: keep the input's format. */
  format?: ImageFormat;
  /** Output quality (1-100) for lossy formats (webp/jpeg/avif). */
  quality?: number;
  /**
   * Preserve every frame of multi-frame inputs (animated webp/gif). Default:
   * `true`; harmless for static images. Animation is only retained when the
   * output `format` is animation-capable (`webp`/`gif`).
   */
  animated?: boolean;
  /** Background used when flattening transparency (e.g. for `contain`/jpeg). */
  background?: string;
}

/** Result of {@link transformImage}: the processed bytes plus resolved metadata. */
export interface ImageTransformResult {
  /** The processed image bytes. */
  data: Buffer;
  /** MIME type of the processed image, e.g. `image/webp`. */
  mime: string;
  /** Resolved output format, e.g. `webp`. */
  format: string;
  /** Width of the processed image in px, if sharp could determine it. */
  width?: number;
  /** Height of the processed image in px, if sharp could determine it. */
  height?: number;
}

/** Reactive state of a single file tracked by `useTusUpload()`. */
export interface TusUploadState {
  file: File;
  /** Upload progress in percent (0-100). */
  progress: number;
  /** True once the tus upload finished successfully. */
  complete: boolean;
  /** Id of the staged upload on the server (last segment of `uploadUrl`). */
  tusId?: string;
  /** Full tus upload URL once the server assigned one. */
  uploadUrl?: string;
  /** Message of the last upload error, if any. */
  error?: string;
}

export interface UseTusUploadOptions {
  /** tus endpoint. Defaults to the route configured via `ablage.tus.route`. */
  endpoint?: string;
  /**
   * Extra tus metadata per file, merged over the default
   * `{ filename, filetype }` pair. Available server-side on the staged
   * upload and used by `useTusStaging().promote()` as meta fallbacks.
   */
  metadata?: (file: File) => Record<string, string>;
  /** Retry backoff in ms. Default: `[0, 3000, 5000, 10000, 20000]`. */
  retryDelays?: number[];
  /** Fixed chunk size in bytes. Default: let tus-js-client decide. */
  chunkSize?: number;
  /** Resume matching unfinished uploads from a previous session. Default: `true`. */
  resume?: boolean;
  /**
   * Delete staged uploads via `sendBeacon` when the page is closed while
   * uploads are still tracked (i.e. not yet promoted and `clear()`ed).
   * Trades resumability across page loads for a tidy staging area.
   * Default: `false`.
   */
  cleanupOnPageHide?: boolean;
  onError?: (file: File, error: Error) => void;
  onSuccess?: (file: File, state: TusUploadState) => void;
}

/** Reactive state of a single file tracked by `useDirectUpload()`. */
export interface DirectUploadState<R = unknown> {
  file: File;
  /** Upload progress in percent (0-100). */
  progress: number;
  /** True once the upload was completed on the server. */
  complete: boolean;
  /** What your `complete` route returned. */
  result?: R;
  /** Message of the last error, if any. `retry()` continues where it stopped. */
  error?: string;
}

export interface UseDirectUploadOptions<R = unknown> {
  /**
   * Starts an upload: your route that calls `useFileStorage().createUpload()`
   * and returns its result. A URL is POSTed `{ name, type, size }` as JSON.
   */
  start: string | ((file: File) => Promise<DirectUpload>);
  /**
   * Finishes an upload: your route that calls `completeUpload(token, { parts })`.
   * A URL is POSTed `{ token, parts }` as JSON.
   */
  complete: string | ((input: { token: string; parts?: CompletedPart[] }, file: File) => Promise<R>);
  /** Cancels an upload via `abortUpload(token)`. A URL is POSTed `{ token }`. */
  abort?: string | ((input: { token: string }, file: File) => Promise<unknown>);
  /** Parts uploaded in parallel. Default: 4. */
  concurrency?: number;
  /** Retry backoff in ms for each PUT. Default: `[0, 1000, 3000, 5000]`. */
  retryDelays?: number[];
  onError?: (file: File, error: Error) => void;
  onSuccess?: (file: File, state: DirectUploadState<R>) => void;
}

/** Options for `useTusStaging().promote()`. */
export interface TusPromoteOptions extends Pick<PutOptions, 'id' | 'overwrite' | 'contentType' | 'name' | 'cacheControl' | 'customMetadata' | 'transform'> {
  /** Remove the staged upload after promoting it. Default: `true`. */
  removeStaged?: boolean;
}

/** Options for `useFileStorage().createUpload()`. */
export interface CreateUploadOptions<M extends CustomMetadata = CustomMetadata>
  extends Pick<PutOptions<M>, 'id' | 'name' | 'cacheControl' | 'customMetadata'> {
  /** Exact size in bytes; the store rejects bytes of any other length. */
  size: number;
  /** Default: `application/octet-stream`. */
  contentType?: string;
  /** Reject (413) before anything is signed. Bytes or `'500KB'` / `'2MB'` / `'1GB'`. */
  maxSize?: number | string;
  /** Accepted types (415 otherwise): MIME types, families like `'image'`, or extensions like `'.pdf'`. */
  types?: string[];
  /** Lifetime of the upload URLs in seconds. Default: 3600. */
  expiresIn?: number;
  /** Part size for multipart uploads; files up to this size use a single PUT. Default: 16 MiB, at least 5 MiB. */
  partSize?: number;
}

/** One presigned part of a multipart upload. */
export interface DirectUploadPart {
  /** 1-based part number. */
  number: number;
  url: string;
  /** Bytes of the file this part covers, starting at `(number - 1) * partSize`. */
  size: number;
}

/** Where a provider wants the bytes of a direct upload sent. */
export type DirectUploadTarget =
  | {
    type: 'single';
    method: 'PUT';
    url: string;
    /** Headers to send with the PUT. They are part of the signature. */
    headers: Record<string, string>;
  }
  | {
    type: 'multipart';
    uploadId: string;
    partSize: number;
    parts: DirectUploadPart[];
  };

/** Returned by `createUpload()`: send it to the browser as-is. */
export type DirectUpload = DirectUploadTarget & FileRef & {
  /** Pass to `completeUpload()` / `abortUpload()`. Signed; carries the declared name, type and size. */
  token: string;
  /** When the upload URLs stop working (ISO 8601). */
  expiresAt: string;
};

/** A finished part of a multipart upload, as reported by the store. */
export interface CompletedPart {
  number: number;
  /** The part's `ETag` response header (the bucket's CORS config must expose it). */
  etag: string;
}

/** Direct-to-store uploads, offered by providers that can presign writes. */
export interface ProviderDirectUploads {
  /** Presign a single PUT or start a multipart upload for the ref's bytes. */
  create(ref: FileRef, options: { size: number; contentType: string; expiresIn: number; partSize: number }): Promise<DirectUploadTarget>;
  /**
   * Finish the transfer (e.g. CompleteMultipartUpload) and report the stored
   * bytes; `null` if they aren't there.
   */
  finish(ref: FileRef, options: { uploadId?: string; parts?: CompletedPart[] }): Promise<{ size: number; etag: string } | null>;
  /** Store metadata for bytes that were uploaded directly. */
  commit(object: FileObject): Promise<void>;
  /** Drop an unfinished upload's bytes or parts. */
  abort(ref: FileRef, options: { uploadId?: string }): Promise<void>;
}

/** Options for a provider's `presignRead()`. */
export interface PresignReadOptions {
  /** Lifetime of the URL in seconds. */
  expiresIn: number;
  /** Headers the store should answer with, overriding what it has stored. */
  responseHeaders: {
    'content-type': string;
    'content-disposition': string;
    'cache-control': string;
  };
}

/**
 * The storage backend behind `useFileStorage()`. Implement it to store files
 * anywhere; register it with `setFileStorageProvider()` in a Nitro plugin.
 *
 * `useFileStorage()` does the bookkeeping (ids, size, etag, timestamps,
 * overwrite checks, transforms), so a provider only persists what it's given.
 */
export interface FileStorageProvider {
  /** The file's metadata, or `null` if it doesn't exist. Must not read the bytes. */
  head(ref: FileRef): Promise<FileObject | null>;
  /**
   * The file's bytes as a stream, or `null` if they don't exist. A `range` is
   * clamped to the stored size (an offset past the end yields an empty stream).
   */
  read(ref: FileRef, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  /** Store bytes and metadata, replacing any existing file at the same ref. */
  write(object: FileObject, data: Uint8Array): Promise<void>;
  /** Apply a {@link FileMetaPatch} (bumping `updatedAt`); `null` if the file doesn't exist. */
  updateMeta(ref: FileRef, patch: FileMetaPatch): Promise<FileObject | null>;
  /** Delete files; missing ones are ignored. */
  remove(refs: FileRef[]): Promise<void>;
  /** A page of a group's files, ordered by id. */
  list(group: string, options: Required<Pick<ListOptions, 'limit'>> & Omit<ListOptions, 'limit'>): Promise<ListResult>;
  /** Optional: the first file whose `customMetadata[key] === value`. */
  findByMeta?(filter: { key: string; value: unknown; group?: string }): Promise<FileObject | null>;
  /**
   * Optional: a URL the client can fetch the bytes from directly, bypassing
   * the app server (e.g. a presigned S3 GET). `signedUrl()` returns it
   * instead of a link to the module's file route.
   */
  presignRead?(ref: FileRef, options: PresignReadOptions): Promise<string>;
  /** Optional: uploads straight from the browser to the store (`createUpload()`). */
  directUploads?: ProviderDirectUploads;
}
